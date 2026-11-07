class Account::DashboardController < Account::ApplicationController
  def index
    redirect_to finance_dashboard_path
  end
end
