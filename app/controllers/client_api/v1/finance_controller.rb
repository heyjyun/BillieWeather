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
        categories = Finance::CustomCategory.where(user_id: current_user.id)
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
        rows = Array(payload[:transactions])
        return render json: {error: "empty"}, status: :unprocessable_entity if rows.empty? || rows.length > MAX_UPLOAD_ROWS
        currency = payload[:currency].to_s.upcase
        sha256 = payload[:sha256].to_s
        parsed = rows.map { |row| parse_row(row) }
        return render json: {error: "invalid"}, status: :unprocessable_entity if parsed.any?(&:nil?)
        closing = payload[:closing_balance].presence && BigDecimal(payload[:closing_balance].to_s, exception: false)
        result = current_user.with_lock do
          record = Finance::Profile.find_or_create_by!(user_id: current_user.id) { |p| p.currency = currency }
          next {error: "currency_mismatch", currency: record.currency, status: :conflict} if record.currency != currency
          if (existing = Finance::Statement.find_by(user_id: current_user.id, sha256: sha256))
            next {id: existing.id, created: false, status: :ok}
          end
          # Categories the person made in the app arrive as names; the cloud adds them as its own custom categories.
          known = {}
          parsed.each { |row| row[:category] = (known[row[:category]] ||= Finance::CustomCategory.ensure_for!(current_user, row[:category])) }
          statement = Finance::Statement.create!(user: current_user, filename: payload[:filename].to_s.first(255), currency: currency,
            sha256: sha256, status: "imported", transaction_count: parsed.length, closing_balance: closing,
            closing_balance_on: closing && parse_date(payload[:closing_balance_on]), balance_observed_on: parsed.map { |r| r[:booked_on] }.max)
          now = Time.current
          parsed.each_slice(500) do |batch|
            Finance::Transaction.insert_all!(batch.map { |a| a.merge(user_id: current_user.id, statement_id: statement.id, created_at: now, updated_at: now) })
          end
          {id: statement.id, created: true, status: :created}
        end
        status = result.delete(:status)
        Finance::BalanceSync.call(user: current_user) if result[:created]
        render json: result, status: status
      rescue ActionController::ParameterMissing, ActiveRecord::RecordInvalid
        render json: {error: "invalid"}, status: :unprocessable_entity
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
        page = Finance::Transaction.where(user_id: current_user.id).where("id > ?", after_id).order(:id).limit(limit).to_a
        render json: {
          transactions: page.map do |transaction|
            {id: transaction.id, statement_id: transaction.statement_id, booked_on: transaction.booked_on.iso8601,
             description: transaction.description, amount: decimal(transaction.amount), category: transaction.category,
             tax_review: transaction.tax_review, excluded: transaction.excluded}
          end,
          next_after_id: (page.length == limit) ? page.last.id : nil
        }
      end

      def rules
        render json: {rules: Finance::MerchantRule.where(user_id: current_user.id).order(:merchant_key, :income)
          .map { |rule| {merchant_key: rule.merchant_key, income: rule.income, category: rule.category} }}
      end

      # The person's own categories (the built-in ones are the same everywhere and not listed).
      def categories
        render json: {categories: Finance::CustomCategory.where(user_id: current_user.id).order(Arel.sql("lower(name)")).pluck(:name)}
      end

      # "Categorize with AI" from an app. The app sends only what its consent screen shows: for
      # each merchant a key, a cleaned description and the direction, plus the names of its own
      # categories. Nothing is stored here; the answer maps keys to category names.
      def categorize
        return render json: {error: "consent_required"}, status: :unprocessable_entity unless params[:consent] == true
        return render json: {error: "not_configured"}, status: :service_unavailable unless Finance::AiCategorizer.available?
        items = Array(params[:items])
        custom = Array(params[:categories])
        if items.empty? || items.length > MAX_CATEGORIZE_ITEMS || custom.length > Finance::CustomCategory::MAX_PER_USER ||
            !custom.all? { |name| name.is_a?(String) && name.length <= Finance::CustomCategory::MAX_LENGTH && name == Finance::CustomCategory.normalize_name(name) && name.present? }
          return render json: {error: "invalid"}, status: :unprocessable_entity
        end
        cleaned = items.map do |item|
          next nil unless item.respond_to?(:[]) && item[:key].is_a?(String) && item[:key].match?(/\A[\w-]{1,20}\z/) && %w[in out].include?(item[:direction])
          text = Finance::AiCategorizer.clean_text(item[:description].to_s.first(200))
          text && {key: item[:key], text: text, direction: item[:direction]}
        end
        return render json: {error: "invalid"}, status: :unprocessable_entity if cleaned.any?(&:nil?) || cleaned.map { |item| item[:key] }.uniq.length != cleaned.length
        Finance::AiCategorizer.claim_run!(current_user)
        suggestions = Finance::AiCategorizer.suggest(items: cleaned, categories: custom - Finance::Transaction::CATEGORIES)
        render json: {assignments: suggestions.map { |key, category| {key: key, category: category} }}
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
        amount = BigDecimal(row[:amount].to_s, exception: false)
        booked_on = parse_date(row[:booked_on])
        description = row[:description].to_s
        return nil if amount.nil? || !amount.finite? || amount != amount.round(2) || amount.abs >= 10**13
        return nil if booked_on.nil? || description.blank? || description.length > 500
        category = Finance::CustomCategory.normalize_name(row[:category])
        return nil if category.empty? || category.length > Finance::CustomCategory::MAX_LENGTH
        {booked_on: booked_on, description: description, amount: amount, category: category,
         tax_review: row[:tax_review] == true, excluded: row[:excluded] == true}
      end

      # Exact decimal as text ("-12.50"), never a float.
      def decimal(value)
        value&.to_d&.to_s("F")&.then { |text| text.include?(".") ? text : "#{text}.0" }
      end
    end
  end
end
