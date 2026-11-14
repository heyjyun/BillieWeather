# Consolidates legacy local database METADATA (see Finance::LocalDatabaseConsolidation).
# Dry run by default. Never touches statements, transactions, rules or any SQLite file.
#
#   bin/rails billie:local_databases:consolidate                       # dry run, every account
#   bin/rails billie:local_databases:consolidate USER_EMAIL=a@b.c      # dry run, one account
#   bin/rails billie:local_databases:consolidate APPLY=yes BACKUP=path.json [USER_EMAIL=…]
namespace :billie do
  namespace :local_databases do
    desc "Archive duplicate legacy local database metadata (dry run unless APPLY=yes)"
    task consolidate: :environment do
      users = ENV["USER_EMAIL"].present? ? User.where(email: ENV["USER_EMAIL"].strip.downcase) : User.all
      abort "No account with that email." if ENV["USER_EMAIL"].present? && users.none?

      consolidation = Finance::LocalDatabaseConsolidation.new(users: users)
      actions = consolidation.plan
      puts Finance::LocalDatabaseConsolidation.describe(actions)

      unless ENV["APPLY"] == "yes"
        puts "\nDry run: nothing was changed. Re-run with APPLY=yes BACKUP=<file.json> to apply."
        next
      end
      abort "APPLY=yes needs BACKUP=<file.json> (a copy of the affected metadata rows is written there first)." if ENV["BACKUP"].blank?

      ids = actions.map(&:report_id)
      backup = {exported_at: Time.current.iso8601, plan: actions.map(&:to_h),
                finance_local_database_reports: Finance::LocalDatabaseReport.where(id: ids).order(:id).map(&:attributes),
                finance_local_devices: Finance::LocalDevice.where(device_id: actions.map(&:device_id).uniq, user_id: actions.map(&:user_id).uniq).order(:id).map(&:attributes)}
      File.write(ENV["BACKUP"], JSON.pretty_generate(backup))
      puts "\nBackup of #{ids.size} metadata row(s) written to #{ENV["BACKUP"]}."

      applied = consolidation.apply!(actions)
      puts "Applied #{applied.size} change(s). Running it again changes nothing."
    end
  end
end
