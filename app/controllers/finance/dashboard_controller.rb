module Finance
  class DashboardController < BaseController
    def index
      @snapshot = Snapshot.new(user: current_user).to_h
      @recent_transactions = current_user.finance_transactions.order(booked_on: :desc, id: :desc).limit(6)
    end
  end
end
