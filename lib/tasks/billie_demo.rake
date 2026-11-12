# The public Example Account (see DemoAccount). Both tasks touch only that one account.
namespace :billie do
  namespace :demo do
    # Running against a remote database (Neon, production) must be a deliberate choice.
    confirm = lambda do
      remote = Rails.env.production? || ENV["DATABASE_URL"].present?
      if remote && ENV["BILLIE_DEMO_CONFIRM"] != "yes"
        abort "This would change the Example Account in a remote database. Re-run with BILLIE_DEMO_CONFIRM=yes to continue."
      end
    end

    desc "Create the Example Account or reset it to fresh synthetic data (only the demo user is changed)"
    task seed: :environment do
      confirm.call
      user = DemoAccount::Seeder.call
      puts "Example Account ready: #{user.finance_statements.count} statements, #{user.finance_transactions.count} transactions."
    end

    desc "Reset the Example Account to fresh synthetic data (same as billie:demo:seed)"
    task reset: :seed

    desc "Delete the Example Account and all of its synthetic data"
    task remove: :environment do
      confirm.call
      user = DemoAccount.user
      next puts("No Example Account to remove.") unless user
      raise "refusing to delete a non-demo account" unless user.demo_account?
      Finance::DataDeletion.call(user: user)
      user.teams.each { |team| team.destroy if team.users.where.not(id: user.id).none? }
      user.destroy!
      puts "Example Account removed."
    end
  end
end
