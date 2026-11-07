class AddBalanceTracking < ActiveRecord::Migration[8.1]
  def change
    # The closing balance printed on a statement, when we can read one.
    add_column :finance_statements, :closing_balance, :decimal, precision: 15, scale: 2
    add_column :finance_statements, :closing_balance_on, :date
    # The same values travel with a PDF draft while it waits for review.
    add_column :finance_statement_drafts, :closing_balance, :decimal, precision: 15, scale: 2
    add_column :finance_statement_drafts, :closing_balance_on, :date
    # Where the profile's current balance came from: "statement" or "manual" (nil = not set).
    add_column :finance_profiles, :balance_source, :string
    add_column :finance_profiles, :balance_as_of, :date
  end
end
