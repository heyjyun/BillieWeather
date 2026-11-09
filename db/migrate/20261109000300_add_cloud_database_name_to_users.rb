class AddCloudDatabaseNameToUsers < ActiveRecord::Migration[8.1]
  def change
    # The person's own label for their BillieWeather cloud database (shown on the website
    # and in the apps). It lives on the user so it survives "delete my financial data".
    add_column :users, :cloud_database_name, :string, limit: 60
  end
end
