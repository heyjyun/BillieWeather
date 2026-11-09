module Admin
  # One person's badges, badge history, and support-payment access.
  class CommunityUsersController < BaseController
    before_action :find_member

    def show
      @honors = @member.community_honors.includes(:granted_by, :revoked_by).order(granted_at: :desc)
      @new_honor = ::Community::Honor.new(confirmed_at: Time.current)
    end
  end
end
