module Finance
  # A simulated import uses exactly the same account resolution, duplicate checks,
  # classification and database constraints as commit. No preview rows survive.
  class ReviewedStatementImport
    def initialize(user:, files:, currency:, date_column: nil)
      @user, @files, @currency, @date_column = user, files, currency, date_column
    end

    def call(token: nil)
      review = nil
      @user.with_lock do
        existing = @user.finance_bank_accounts.pluck(:id).to_set
        results = BatchStatementImport.new(user: @user, files: @files, currency: @currency, date_column: @date_column).call
        evidence = results.map do |result|
          record = result[:statement] || result[:draft]
          account = record&.bank_account
          rows = if result[:statement]
            record.transactions.order(:id).pluck(:booked_on, :description, :amount, :category).map { |d, name, amount, category| [d.iso8601, name, amount.to_s("F"), category] }
          elsif record
            record.rows.map { |r| r.values_at("booked_on", "description", "amount") }
          else
            []
          end
          {filename: result[:filename], status: result[:status], sha256: record&.sha256, count: rows.size, rows: rows,
           account: account&.display_name || (record.account_identity.values_at("bank_name","account_name","account_last4").compact.join(" · ").presence if record.is_a?(StatementDraft) && record.account_identity["account_key"].present?), account_id: (account.id if account && existing.include?(account.id)), error: (result[:message] if result[:status] == "failed")}
        end
        digest = Digest::SHA256.hexdigest([@user.id, @currency, evidence].to_json)
        verifier = Rails.application.message_verifier("reviewed-statement-import")
        if token
          unless verifier.verified(token, purpose: "statement_review") == digest
            raise StatementImporter::ImportError, I18n.t("billie.backend.pdf_needs_review")
          end
          review = results
        else
          review = {files: evidence.map { |item| item.except(:sha256).merge(rows: item[:rows].first(10)) },
            token: verifier.generate(digest, purpose: "statement_review", expires_in: 15.minutes)}
          raise ActiveRecord::Rollback
        end
      end
      review
    end
  end
end
