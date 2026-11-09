class AddNicknameToUsers < ActiveRecord::Migration[8.1]
  # A self-chosen display name replaces first and last name, so new accounts
  # no longer have to hand over their legal name.
  def change
    add_column :users, :nickname, :string, limit: 40
  end
end
