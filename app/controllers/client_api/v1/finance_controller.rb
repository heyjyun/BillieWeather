module ClientApi
  module V1
    # Read-only download of the signed-in person's web financial data, so the apps can
    # copy it into their local database. Nothing here accepts financial data from the
    # apps: they never upload statements or transactions. Every query is scoped to
    # current_user.
    class FinanceController < BaseController
      PAGE_SIZE = 2_000

      before_action :authenticate_client!
      rate_limit to: 60, within: 1.minute, by: -> { request.remote_ip },
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      # A fingerprint of everything the apps download. It changes when anything is
      # added, edited, or deleted, so an app only downloads again when needed.
      def show
        statements = Finance::Statement.where(user_id: current_user.id)
        transactions = Finance::Transaction.where(user_id: current_user.id)
        rules = Finance::MerchantRule.where(user_id: current_user.id)
        parts = [
          statements.count, statements.maximum(:updated_at)&.utc&.iso8601(6),
          transactions.count, transactions.maximum(:updated_at)&.utc&.iso8601(6),
          rules.count, rules.maximum(:updated_at)&.utc&.iso8601(6),
          profile&.currency
        ]
        render json: {
          currency: profile&.currency,
          version: Digest::SHA256.hexdigest(parts.to_json),
          statement_count: parts[0], transaction_count: parts[2], rule_count: parts[4]
        }
      end

      def statements
        rows = Finance::Statement.where(user_id: current_user.id).order(:id).map do |statement|
          {id: statement.id, filename: statement.filename, currency: statement.currency, sha256: statement.sha256,
           transaction_count: statement.transaction_count, closing_balance: decimal(statement.closing_balance),
           closing_balance_on: statement.closing_balance_on&.iso8601, imported_at: statement.created_at.utc.iso8601}
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

      private

      def profile
        @profile ||= Finance::Profile.find_by(user_id: current_user.id)
      end

      # Exact decimal as text ("-12.50"), never a float.
      def decimal(value)
        value&.to_d&.to_s("F")&.then { |text| text.include?(".") ? text : "#{text}.0" }
      end
    end
  end
end
