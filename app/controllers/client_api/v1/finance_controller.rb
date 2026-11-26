module ClientApi
  module V1
    # The signed-in person's cloud financial data, for the apps' Data page: a summary (with
    # storage size and the database's name), a download into the app's local database,
    # and the actions the person asks for there: upload one statement from a local database
    # (a transfer), rename the cloud database, delete one statement, or delete the whole cloud
    # database (only with the typed confirmation). Every query is scoped to current_user.
    class FinanceController < BaseController
      PAGE_SIZE = 2_000
      MAX_UPLOAD_ROWS = 50_000
      MAX_CATEGORIZE_ITEMS = Finance::AiCategorizer::MAX_ITEMS

      before_action :authenticate_client!
      rate_limit to: 60, within: 1.minute, by: -> { request.remote_ip },
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      # A fingerprint of everything the apps download. It changes when anything is
      # added, edited, or deleted, so an app only downloads again when needed.
      def show
        statements = Finance::Statement.where(user_id: current_user.id)
        transactions = Finance::Transaction.where(user_id: current_user.id)
        rules = Finance::MerchantRule.where(user_id: current_user.id)
        categories = Finance::Category.for_user(current_user)
        parts = [
          statements.count, statements.maximum(:updated_at)&.utc&.iso8601(6),
          transactions.count, transactions.maximum(:updated_at)&.utc&.iso8601(6),
          rules.count, rules.maximum(:updated_at)&.utc&.iso8601(6),
          profile&.currency,
          categories.count, categories.maximum(:updated_at)&.utc&.iso8601(6)
        ]
        render json: {
          currency: profile&.currency,
          name: current_user.cloud_database_name,
          version: Digest::SHA256.hexdigest(parts.to_json),
          statement_count: parts[0], transaction_count: parts[2], rule_count: parts[4],
          bank_account_count: overview.bank_account_count,
          pending_import_count: overview.pending_import_count,
          insight_count: overview.insight_count,
          last_updated_at: [parts[1], parts[3], parts[5]].compact.max,
          period_start: overview.period_start&.iso8601,
          period_end: overview.period_end&.iso8601,
          storage_bytes: overview.storage_bytes
        }
      end

      def rename
        if current_user.update(cloud_database_name: params[:name])
          render json: {name: current_user.cloud_database_name}
        else
          render json: {error: "invalid_name"}, status: :unprocessable_entity
        end
      end

      # Deletes the whole cloud database (statements, transactions, rules, bank accounts,
      # analyses, balances), keeping the login and the database's name. The caller must send
      # confirm=delete, which the apps only do after the person typed the confirmation.
      def destroy_all
        return render json: {error: "confirmation_required"}, status: :unprocessable_entity unless params[:confirm] == "delete"
        counts = Finance::DataDeletion.call(user: current_user)
        render json: {deleted: counts}
      end

      # Adds ONE statement (with its transactions) that the person chose to send from a local
      # database. The same file (SHA-256) is never stored twice, and the cloud keeps one currency.
      def create_statement
        payload = params.require(:statement)
        # Every value comes from a device: check shapes before use, so bad input is a 422 and never a 500.
        return render json: {error: "invalid"}, status: :unprocessable_entity unless payload.is_a?(ActionController::Parameters)
        sha256 = payload[:sha256]
        return render json: {error: "invalid_sha256"}, status: :unprocessable_entity unless sha256.is_a?(String) && sha256.match?(SHA256_FORMAT)
        return render json: {error: "invalid"}, status: :unprocessable_entity unless payload[:transactions].is_a?(Array)
        return render json: {error: "invalid"}, status: :unprocessable_entity unless payload[:currency].is_a?(String) && payload[:filename].is_a?(String)
        rows = payload[:transactions]
        return render json: {error: "empty"}, status: :unprocessable_entity if rows.empty? || rows.length > MAX_UPLOAD_ROWS
        currency = payload[:currency].upcase
        parsed = rows.map { |row| parse_row(row) }
        return render json: {error: "invalid"}, status: :unprocessable_entity if parsed.any?(&:nil?)
        closing = upload_closing_balance(payload)
        return render json: {error: "invalid"}, status: :unprocessable_entity if closing == :invalid
        account = payload[:account].presence && upload_account_details(payload[:account])
        return render json: {error: "invalid"}, status: :unprocessable_entity if account == :invalid
        upload_categories = parse_upload_categories(payload.key?(:categories) ? payload[:categories] : params[:categories])
        return render json: {error: "invalid"}, status: :unprocessable_entity if upload_categories == :invalid
        result = current_user.with_lock do
          record = Finance::Profile.find_or_create_by!(user_id: current_user.id) { |p| p.currency = currency }
          next {error: "currency_mismatch", currency: record.currency, status: :conflict} if record.currency != currency
          if (existing = Finance::Statement.find_by(user_id: current_user.id, sha256: sha256))
            next {id: existing.id, created: false, status: :ok}
          end
          # The app may describe its categories (parents first): missing ones are created under their
          # parent. Names still unknown after that arrive as roots, as before.
          upload_categories.each { |item| ensure_upload_category(item) }
          known = {}
          parsed.each { |row| row[:category] = (known[row[:category]] ||= Finance::Category.ensure_for!(current_user, row[:category])) }
          # Same classification and cross-file duplicate check as a website import; the device's
          # categories are kept (they were decided there).
          # The account the device identified (bank, last four digits, kind) files the statement under
          # the same account as the website's own imports of it: duplicates are compared per account.
          bank_account = upload_account(account)
          plan = Finance::ImportPlan.new(user: current_user, rows: parsed, bank_account: bank_account, origin: "upload", category_source: "file")
          next {error: "all_duplicates", skipped: plan.skipped, status: :conflict} if plan.empty?
          statement = Finance::Statement.create!(user: current_user, filename: payload[:filename].to_s.first(255), currency: currency,
            bank_account: bank_account, sha256: sha256, transaction_count: plan.rows.length, closing_balance: closing,
            closing_balance_on: closing && parse_date(payload[:closing_balance_on]), balance_observed_on: parsed.map { |r| r[:booked_on] }.max)
          plan.insert!(statement)
          {id: statement.id, created: true, skipped_duplicates: plan.skipped, flagged_duplicates: plan.flagged.length, status: :created}
        end
        status = result.delete(:status)
        Finance::BalanceSync.call(user: current_user) if result[:created]
        render json: result, status: status
      rescue ActionController::ParameterMissing, ActiveRecord::RecordInvalid
        render json: {error: "invalid"}, status: :unprocessable_entity
      end

      UPLOAD_ACCOUNT_KINDS = {"checking" => "cash", "savings" => "cash", "credit_card" => "credit", "loan" => "credit"}.freeze
      # Lower-case hex, exactly 64 characters: the same rule as Finance::Statement and the database CHECK.
      SHA256_FORMAT = /\A[0-9a-f]{64}\z/

      # The closing balance a device reported: nil when absent, :invalid when it is not an exact amount
      # (at most 2 decimals, within the column's range) or when its date is not an ISO date.
      private def upload_closing_balance(payload)
        raw = payload[:closing_balance]
        return nil if raw.blank?
        return :invalid unless raw.is_a?(String) || raw.is_a?(Numeric)
        amount = BigDecimal(raw.to_s, exception: false)
        return :invalid if amount.nil? || !amount.finite? || amount != amount.round(2) || amount.abs >= 10**13
        return :invalid if payload[:closing_balance_on].present? && parse_date(payload[:closing_balance_on]).nil?
        amount
      end

      # {institution:, last4:, kind:} from a device, or :invalid. Only four digits are accepted: a
      # full account number is refused rather than stored or silently shortened.
      private def upload_account_details(value)
        return :invalid unless value.respond_to?(:to_unsafe_h)
        details = value.to_unsafe_h.slice("institution", "last4", "kind")
        institution = details["institution"]
        return :invalid unless details["last4"].is_a?(String) && details["last4"].match?(/\A\d{4}\z/)
        return :invalid unless institution.nil? || (institution.is_a?(String) && institution.length <= 100 && !institution.match?(/[\x00-\x1f]/))
        return :invalid unless details["kind"].is_a?(String) && (UPLOAD_ACCOUNT_KINDS.key?(details["kind"]) || details["kind"] == "unknown")
        details.symbolize_keys
      end

      # The website account for a device's account identity, or nil when the identity is not
      # complete enough to name exactly one account (no bank or an unknown kind).
      private def upload_account(details)
        return nil unless details && details[:institution].present? && UPLOAD_ACCOUNT_KINDS.key?(details[:kind])
        identity = Finance::StatementAccountIdentity.from_details(bank_name: details[:institution], account_last4: details[:last4],
          account_kind: UPLOAD_ACCOUNT_KINDS.fetch(details[:kind]), account_name: details[:kind].tr("_", " "))
        account = Finance::BankAccount.resolve(user: current_user, identity: identity)
        account.update!(account_type: details[:kind]) if account&.previously_new_record?
        account
      end

      # Deletes ONE statement (and its transactions) from the cloud, the same way the
      # website's statement list does. There is deliberately no "delete everything" here:
      # that stays on the website, behind its own confirmation.
      def destroy_statement
        statement = Finance::Statement.where(user_id: current_user.id).find(params[:id])
        statement.destroy!
        Finance::BalanceSync.call(user: current_user)
        Finance::Profile.where(user_id: current_user.id).touch_all
        render json: {deleted: {id: statement.id, transactions: statement.transaction_count}}
      rescue ActiveRecord::RecordNotFound
        render json: {error: "not_found"}, status: :not_found
      end

      def statements
        rows = overview.statements(order: :id).map do |item|
          statement = item.statement
          {id: statement.id, filename: statement.filename, currency: statement.currency, sha256: statement.sha256,
           transaction_count: statement.transaction_count, closing_balance: decimal(statement.closing_balance),
           closing_balance_on: statement.closing_balance_on&.iso8601, imported_at: statement.created_at.utc.iso8601,
           period_start: item.period_start&.iso8601, period_end: item.period_end&.iso8601}
        end
        render json: {statements: rows}
      end

      # Pages ordered by id: pass the last id you received as after_id.
      def transactions
        after_id = params[:after_id].to_i
        limit = params[:limit].to_i.clamp(1, PAGE_SIZE)
        limit = PAGE_SIZE if params[:limit].blank?
        page = Finance::Transaction.live.where(user_id: current_user.id).where.not(statement_id: nil).where("id > ?", after_id).order(:id).limit(limit).to_a
        render json: {
          transactions: page.map do |transaction|
            {id: transaction.id, uuid: transaction.uuid, statement_id: transaction.statement_id, booked_on: transaction.booked_on.iso8601,
             description: transaction.description, original_description: transaction.original_description, amount: decimal(transaction.amount),
             category: transaction.category, kind: transaction.kind, tax_review: transaction.tax_review, excluded: transaction.excluded}
          end,
          next_after_id: (page.length == limit) ? page.last.id : nil
        }
      end

      def rules
        render json: {rules: Finance::MerchantRule.where(user_id: current_user.id).order(:merchant_key, :income)
          .map { |rule| {merchant_key: rule.merchant_key, income: rule.income, category: rule.category} }}
      end

      # The person's categories (docs/architecture/category-hierarchy.md, Sync). `categories` keeps its
      # old meaning for older apps: every name except the ten legacy built-in names. `tree` lists every
      # category, parents before children (never `expanded`: that preference stays per database).
      def categories
        tree = Finance::CategoryTree.new(current_user)
        legacy = Finance::DefaultCategories::LEGACY_NAMES
        render json: {
          categories: tree.nodes.map(&:name).reject { |name| legacy.include?(name) }.sort_by { |name| [name.downcase, name] },
          tree: tree.as_wire
        }
      end

      # "Categorize with AI" from an app. The app sends only what its consent screen shows: for
      # each merchant a key, a cleaned description and the direction, plus its categories as names or
      # full paths ("Food & dining › Groceries"). Nothing is stored here; the answer maps keys to
      # category names and may propose new subcategories (`proposals`, ignored by older apps).
      def categorize
        return render json: {error: "consent_required"}, status: :unprocessable_entity unless params[:consent] == true
        return render json: {error: "not_configured"}, status: :service_unavailable unless Finance::AiCategorizer.available?
        items = Array(params[:items])
        custom = Array(params[:categories])
        if items.empty? || items.length > MAX_CATEGORIZE_ITEMS || custom.length > Finance::Category::MAX_PER_USER ||
            !custom.all? { |name| valid_category_reference?(name) }
          return render json: {error: "invalid"}, status: :unprocessable_entity
        end
        cleaned = items.map do |item|
          next nil unless item.respond_to?(:[]) && item[:key].is_a?(String) && item[:key].match?(/\A[\w-]{1,20}\z/) && %w[in out].include?(item[:direction])
          text = Finance::AiCategorizer.clean_text(item[:description].to_s.first(200))
          text && {key: item[:key], text: text, direction: item[:direction]}
        end
        return render json: {error: "invalid"}, status: :unprocessable_entity if cleaned.any?(&:nil?) || cleaned.map { |item| item[:key] }.uniq.length != cleaned.length
        Finance::AiCategorizer.claim_run!(current_user)
        result = Finance::AiCategorizer.suggest_with_proposals(items: cleaned, categories: custom, legacy: true)
        render json: {
          assignments: result[:assignments].map { |key, category| {key: key, category: category} },
          proposals: result[:proposals].map { |proposal| proposal.slice(:parent, :name, :keys) }
        }
      rescue Finance::AiCategorizer::Error => error
        status = {wait: :too_many_requests, not_configured: :service_unavailable, quota: :service_unavailable}.fetch(error.code, :bad_gateway)
        render json: {error: error.code.to_s}, status: status
      end

      private

      def profile
        @profile ||= Finance::Profile.find_by(user_id: current_user.id)
      end

      def overview
        @overview ||= Finance::DatabaseOverview.new(current_user)
      end

      def parse_date(value)
        Date.iso8601(value.to_s)
      rescue Date::Error
        nil
      end

      # One uploaded transaction, validated like an imported one; nil if anything is off.
      def parse_row(row)
        return nil unless row.respond_to?(:key?) && row.respond_to?(:[])
        amount = BigDecimal(row[:amount].to_s, exception: false)
        booked_on = parse_date(row[:booked_on])
        description = row[:description].to_s
        return nil if amount.nil? || !amount.finite? || amount != amount.round(2) || amount.abs >= 10**13
        return nil if booked_on.nil? || description.blank? || description.length > 500
        original_description = row.key?(:original_description) ? row[:original_description] : description
        return nil unless original_description.is_a?(String) && original_description.present? && original_description.length <= 500
        kind = row[:kind]
        return nil if row.key?(:kind) && !Finance::Domain::TRANSACTION_KINDS.include?(kind)
        category = Finance::Category.normalize_name(row[:category])
        return nil if category.empty? || category.length > Finance::Category::MAX_LENGTH
        {booked_on: booked_on, description: description, original_description: original_description, kind: kind, amount: amount, category: category,
         tax_review: row[:tax_review] == true, excluded: row[:excluded] == true}
      end

      # A category name, or a path of names joined by " › ", each part already normalized.
      def valid_category_reference?(value)
        return false unless value.is_a?(String) && value.present? && value.length <= 400
        parts = value.split(Finance::Category::PATH_SEPARATOR.strip).map(&:strip)
        parts.any? && parts.all? { |part| part.present? && part.length <= Finance::Category::MAX_LENGTH && part == Finance::Category.normalize_name(part) } &&
          (parts.length > 1 || value == Finance::Category.normalize_name(value))
      end

      # [{name:, parent:, kind:}] from a statement upload (parents first), [] when absent, :invalid when malformed.
      def parse_upload_categories(value)
        return [] if value.nil?
        return :invalid unless value.is_a?(Array) && value.length <= Finance::Category::MAX_PER_USER
        value.map do |item|
          return :invalid unless item.respond_to?(:key?) && item.respond_to?(:[])
          name = item[:name]
          parent = item[:parent]
          kind = item[:kind]
          return :invalid unless name.is_a?(String) && (parent.nil? || parent.is_a?(String)) && (kind.nil? || Finance::Category::KINDS.include?(kind))
          name = Finance::Category.normalize_name(name)
          parent = parent && Finance::Category.normalize_name(parent).presence
          return :invalid if name.empty? || name.length > Finance::Category::MAX_LENGTH || (parent && parent.length > Finance::Category::MAX_LENGTH)
          {name: name, parent: parent, kind: kind}
        end
      end

      # Creates one category an app described, unless the cloud already has that name. A root of kind
      # transfer goes under the Transfers category (people cannot create transfer roots).
      def ensure_upload_category(item)
        return if item[:name].casecmp?(Finance::Category::UNCATEGORIZED) || Finance::Category.lookup(current_user, item[:name])
        parent = item[:parent]
        parent = Finance::Category.name_for_key(current_user, Finance::DefaultCategories::TRANSFERS_KEY) if parent.nil? && item[:kind] == "transfer"
        parent = nil if parent == Finance::Category::UNCATEGORIZED || (parent && Finance::Category.lookup(current_user, parent).nil?)
        Finance::Category.ensure_for!(current_user, item[:name], parent: parent, kind: item[:kind])
      end

      # Exact decimal as text ("-12.50"), never a float.
      def decimal(value)
        value&.to_d&.to_s("F")&.then { |text| text.include?(".") ? text : "#{text}.0" }
      end
    end
  end
end
