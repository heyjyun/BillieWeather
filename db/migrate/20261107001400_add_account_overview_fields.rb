class AddAccountOverviewFields < ActiveRecord::Migration[8.1]
  def change
    # A name the person chose for an account. It always wins over the name read from the statement.
    add_column :finance_bank_accounts, :custom_name, :string
    # Physical cash can't be read from a statement, so it is only ever entered by hand.
    add_column :finance_profiles, :cash_on_hand, :decimal, precision: 15, scale: 2, null: false, default: 0
    add_column :finance_profiles, :cash_on_hand_on, :date
  end
end
