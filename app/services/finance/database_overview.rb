module Finance
  # What one person's BillieWeather cloud database holds: counts, the dates it covers,
  # when it last changed, an approximate size, and each statement with its date range.
  # Shared by Settings › Your database on the website and the apps' Data page (via the
  # client API), so both show the same numbers. Read-only; every query is scoped to the user.
  class DatabaseOverview
    STORAGE_TABLES = DataDeletion::MODELS.map(&:table_name).freeze

    Item = Struct.new(:statement, :period_start, :period_end, keyword_init: true)

    def initialize(user)
      raise ArgumentError, "a saved user is required" unless user&.persisted?
      @user_id = user.id
    end

    def statement_count = scoped(Statement).count
    def transaction_count = scoped(Transaction).count
    def rule_count = scoped(MerchantRule).count
    def bank_account_count = scoped(BankAccount).count
    def pending_import_count = scoped(StatementDraft).count
    def insight_count = scoped(Insight).count

    def period_start = scoped(Transaction).minimum(:booked_on)
    def period_end = scoped(Transaction).maximum(:booked_on)

    # The most recent change to a statement, transaction or rule.
    def last_updated_at
      [Statement, Transaction, MerchantRule].filter_map { |model| scoped(model).maximum(:updated_at) }.max
    end

    def empty?
      statement_count.zero? && pending_import_count.zero? && rule_count.zero? && bank_account_count.zero?
    end

    # Approximate bytes this person's financial rows take in Postgres (row data only,
    # without shared index overhead).
    def storage_bytes
      @storage_bytes ||= STORAGE_TABLES.sum do |table|
        connection = ActiveRecord::Base.connection
        sql = ActiveRecord::Base.sanitize_sql_array(["SELECT COALESCE(SUM(pg_column_size(t.*)), 0) FROM #{connection.quote_table_name(table)} t WHERE t.user_id = ?", @user_id])
        connection.select_value(sql).to_i
      end
    end

    # Every statement with the first and last date of its transactions, newest first
    # unless an order is given.
    def statements(order: {created_at: :desc, id: :desc})
      periods = scoped(Transaction).group(:statement_id).pluck(:statement_id, Arel.sql("MIN(booked_on)"), Arel.sql("MAX(booked_on)"))
        .to_h { |id, first, last| [id, [first, last]] }
      scoped(Statement).order(order).map do |statement|
        first, last = periods[statement.id]
        Item.new(statement: statement, period_start: first, period_end: last)
      end
    end

    private

    def scoped(model) = model.where(user_id: @user_id)
  end
end
