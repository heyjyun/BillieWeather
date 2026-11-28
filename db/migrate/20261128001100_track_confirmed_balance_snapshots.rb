class TrackConfirmedBalanceSnapshots < ActiveRecord::Migration[8.1]
  def change
    add_column :finance_bank_accounts, :balance_snapshot, :boolean, default: false, null: false
  end
end
