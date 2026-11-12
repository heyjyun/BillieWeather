require "openssl"
require "digest"

module Finance
  module SmartCommand
    # The website's trusted command executor. The browser parses a command into a plan with the
    # shared engine; nothing in that plan is trusted here. Every preview and execution re-checks the
    # plan's shape, protocol, scope (this person), action (from the generated manifest), arguments
    # (against this person's own categories) and confirmation level, then runs the website's own
    # Finance models, scoped to the signed-in user. Mirrors ActionExecutor in @nlae/core.
    #
    # Data changes additionally:
    # - must have been previewed: execution recomputes the preview under row locks and refuses
    #   (stale_preview) when it differs from what the person confirmed;
    # - run in one database transaction with the idempotency record: all or nothing;
    # - are idempotent per person and key for a day: a repeat replays the stored result, a
    #   concurrent duplicate waits on the unique index and then replays;
    # - can be undone once, within UNDO_TTL, only if nothing they touched changed since.
    class Executor
      PROTOCOL = Manifest::PROTOCOL
      UNDO_TTL = 10.minutes
      KEY = /\A[A-Za-z0-9_-]{8,100}\z/
      TOKEN = /\A[A-Za-z0-9_-]{20,100}\z/

      # Opaque per-person scope for plans, so a plan made in one account is refused in another.
      def self.tenant_for(user)
        "web-#{OpenSSL::HMAC.hexdigest("SHA256", Rails.application.secret_key_base, "smart-command-tenant:#{user.id}").first(24)}"
      end

      attr_reader :tenant

      # urls: {pages: {"dashboard" => "/app", …}, transactions: ->(params) { path }}
      # money: ->(amount) { "$1.00" } · category_label: ->(name) { localized name }
      def initialize(user:, urls:, money:, category_label:, manifest: Manifest.current, now: Time.current)
        @user = user
        @manifest = manifest
        @now = now
        @tenant = self.class.tenant_for(user)
        @reads = ReadHandlers.new(user: user, urls: urls, money: money, category_label: category_label)
        @writes = WriteHandlers.new(user: user, category_label: category_label)
        @validator = PlanValidator.new(manifest: manifest, product: manifest.product, tenant: @tenant, entities: method(:entity_ids))
      end

      def actions
        ReadHandlers::ACTIONS + WriteHandlers::ACTIONS
      end

      # Concrete operations (no writes) and a server-keyed fingerprint of them.
      def preview(plan)
        action, args = @validator.admit(plan, allowed_actions: actions)
        prepared = prepare(action, args)
        {ok: true, summary: prepared[:summary], plan: plan.merge("operations" => prepared[:operations], "fingerprint" => fingerprint(action, args, prepared[:operations]),
          "risk" => action["risk"], "confirmation" => @manifest.confirmation_for(action), "confirmationPhrase" => nil)}.compact
      rescue Rejection => rejection
        {ok: false, plan: plan.is_a?(Hash) ? plan : {}, rejection: {code: rejection.code, summary: rejection.summary}}
      end

      def execute(request)
        plan = request.is_a?(Hash) ? request["plan"] : nil
        plan_id = (plan.is_a?(Hash) && plan["planId"].is_a?(String)) ? plan["planId"].first(100) : "unknown"
        raise Rejection.new("protocol_mismatch", "Unsupported protocol version.") unless request.is_a?(Hash) && request["protocol"] == PROTOCOL
        action, args = @validator.admit(plan, allowed_actions: actions)
        level = @manifest.confirmation_for(action)
        # Typed confirmations (deleting) are not offered on the website.
        raise Rejection.new("unknown_action", "That action is not available.") if level == "typed"
        if level == "confirm" && request.dig("confirmation", "confirmed") != true
          raise Rejection.new("confirmation_required", "Please confirm this action first.")
        end
        return run_read(plan_id, action, args) if action["risk"] == "none"
        key = request["idempotencyKey"].nil? ? plan_id : request["idempotencyKey"]
        raise Rejection.new("malformed_plan", "The plan is malformed (idempotencyKey).") unless key.is_a?(String) && KEY.match?(key)
        run_write(plan_id, key, action, args, plan["fingerprint"])
      rescue Rejection => rejection
        result(plan_id, "rejected", rejection.summary, code: rejection.code)
      end

      def undo(token)
        unavailable = -> { result("undo", "rejected", message("undo_unavailable", "There is nothing to undo."), code: "undo_unavailable") }
        return unavailable.call unless token.is_a?(String) && TOKEN.match?(token)
        CommandExecution.transaction do
          # Scoped to this person: someone else's token is simply not found.
          record = @user.finance_command_executions.lock.find_by(undo_token_digest: Digest::SHA256.hexdigest(token))
          next unavailable.call if record.nil? || record.undone_at || record.undo_payload.nil?
          next result("undo", "rejected", message("undo_expired", "It is too late to undo this."), code: "undo_expired") if record.undo_expires_at < @now
          summary = @writes.undo(record.action_id, record.undo_payload)
          # One-shot: the previous state is dropped as soon as it has been restored.
          record.update!(undone_at: @now, undo_payload: nil)
          result("undo", "succeeded", summary)
        end
      rescue Rejection => rejection
        result("undo", "rejected", rejection.summary, code: rejection.code)
      rescue ActiveRecord::ActiveRecordError => error
        log_failure("undo", error)
        result("undo", "failed", message("handler_error", "The action could not be completed."), code: "handler_error")
      end

      private

      def message(code, text, vars = {})
        {code: code, message: text, vars: vars}
      end

      # {operations:, summary:, payload:}; raises no_effect when a data change would change nothing.
      def prepare(action, args, lock: false)
        return {operations: @reads.prepare(action["id"], args)} if action["risk"] == "none"
        prepared = @writes.prepare(action["id"], args, lock: lock)
        if prepared[:operations].empty?
          summary = prepared[:summary] || message("no_effect", "Nothing would change.")
          raise Rejection.new("no_effect", summary[:message], summary[:vars], summary_code: summary[:code])
        end
        prepared
      end

      def run_read(plan_id, action, args)
        outcome = @reads.execute(action["id"], args)
        result(plan_id, "succeeded", outcome[:summary], data: outcome[:data], operations: @reads.prepare(action["id"], args))
      end

      def run_write(plan_id, key, action, args, previewed)
        digest = Digest::SHA256.hexdigest(canonical([action["id"], args]))
        CommandExecution.prune!(@user)
        CommandExecution.transaction do
          record, created = claim(key, action, digest)
          next replay(record, digest) unless created

          prepared = prepare(action, args, lock: true)
          unless previewed.is_a?(String) && ActiveSupport::SecurityUtils.secure_compare(previewed, fingerprint(action, args, prepared[:operations]))
            raise Rejection.new("stale_preview", "The data changed since the preview. Review the updated preview.")
          end
          outcome = @writes.execute(action["id"], prepared, args)
          undo = ({token: undo_token(record), expiresAt: (@now + UNDO_TTL).iso8601} if action["undoable"] && outcome[:undo])
          record.update!(result: {"summary" => outcome[:summary], "count" => prepared[:operations].size}, undo_payload: undo && outcome[:undo],
            undo_token_digest: undo && Digest::SHA256.hexdigest(undo[:token]), undo_expires_at: undo && @now + UNDO_TTL)
          result(plan_id, "succeeded", outcome[:summary], undo: undo, operations: prepared[:operations])
        end
      rescue Rejection
        # Raised inside the transaction: it rolled back, including the idempotency record, so the
        # person can fix the command and run it again.
        raise
      rescue ActiveRecord::ActiveRecordError => error
        log_failure(action["id"], error)
        result(plan_id, "failed", message("handler_error", "The action could not be completed."), code: "handler_error")
      end

      # Inserts the idempotency record in a savepoint. When the key exists, or a concurrent request
      # is inserting it (Postgres makes this one wait for that transaction), returns the stored one.
      def claim(key, action, digest)
        record = CommandExecution.transaction(requires_new: true) do
          @user.finance_command_executions.create!(idempotency_key: key, action_id: action["id"], request_digest: digest)
        end
        [record, true]
      rescue ActiveRecord::RecordNotUnique
        [@user.finance_command_executions.find_by!(idempotency_key: key), false]
      end

      def replay(record, digest)
        unless ActiveSupport::SecurityUtils.secure_compare(record.request_digest, digest)
          raise Rejection.new("idempotency_conflict", "This command was already used for a different change. Type it again.")
        end
        undo = if record.undo_token_digest && record.undone_at.nil? && record.undo_expires_at > @now
          {token: undo_token(record), expiresAt: record.undo_expires_at.iso8601}
        end
        summary = (record.result["summary"] || message("no_effect", "Nothing would change.")).deep_symbolize_keys
        result(record.idempotency_key, "succeeded", summary, undo: undo, replayed: true)
      end

      # Derived from the record, so a replayed result can hand out the same token; only its digest is stored.
      def undo_token(record)
        OpenSSL::HMAC.hexdigest("SHA256", Rails.application.secret_key_base, "smart-command-undo:#{@user.id}:#{record.id}:#{record.idempotency_key}")
      end

      def result(plan_id, status, summary, code: nil, data: nil, undo: nil, operations: [], replayed: false)
        {protocol: PROTOCOL, planId: plan_id, status: status, code: code, summary: summary, data: data}.compact
          .merge(undo: undo, replayed: replayed, operations: operations)
      end

      # Only the error class: messages can contain record values.
      def log_failure(action_id, error)
        Rails.logger.warn("[smart_command] #{action_id} failed for user #{@user.id}: #{error.class}")
      end

      # What command arguments may refer to: only this person's categories.
      def entity_ids(kind)
        @entity_ids ||= {}
        @entity_ids[kind] ||= case kind
        when "category" then CustomCategory.names_for(@user)
        when "customCategory" then @user.finance_custom_categories.pluck(:name)
        else []
        end
      end

      # Keyed hash of what a preview showed. Only the server can produce it, and execution recomputes
      # it from the current data: a different value means the data changed since the preview.
      def fingerprint(action, args, operations)
        OpenSSL::HMAC.hexdigest("SHA256", Rails.application.secret_key_base, canonical(["smart-command-preview", @tenant, action["id"], args, operations])).first(32)
      end

      def canonical(value)
        case value
        when Hash then "{" + value.map { |key, inner| [key.to_s, inner] }.sort_by(&:first).map { |key, inner| "#{key.to_json}:#{canonical(inner)}" }.join(",") + "}"
        when Array then "[" + value.map { |inner| canonical(inner) }.join(",") + "]"
        when Symbol then value.to_s.to_json
        else value.to_json
        end
      end
    end
  end
end
