require "csv"
require "stringio"

module Finance
  # Turns reviewed (or automatically accepted) PDF draft rows into a real statement.
  class DraftImport
    def initialize(user:, draft:, rows: nil)
      @user = user
      @draft = draft
      @rows = rows || draft.rows.map { |row| row.merge("include" => "1") }
    end

    def call
      included_rows = @rows.select { |row| row["include"] == "1" }
      raise StatementImporter::ImportError, I18n.t("billie.backend.select_transaction") if included_rows.empty?

      csv = CSV.generate do |output|
        output << ["Date", "Description", "Amount", "Currency"]
        included_rows.each { |row| output << [row["booked_on"], row["description"], row["amount"], @draft.currency] }
      end
      stream = StringIO.new(csv)
      stream.define_singleton_method(:original_filename) { "reviewed-transactions.csv" }
      statement = StatementImporter.new(user: @user, file: stream, currency: @draft.currency,
        source_sha256: @draft.sha256, source_filename: @draft.filename,
        closing_balance: @draft.closing_balance, closing_balance_on: @draft.closing_balance_on,
        bank_account: @draft.bank_account, balance_observed_on: @draft.balance_observed_on).call
      @draft.destroy!
      statement
    end
  end
end
