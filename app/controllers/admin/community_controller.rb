module Admin
  # Find people by nickname (or email). Payment QR codes live on Admin → Payment Methods.
  class CommunityController < BaseController
    def index
      @query = params[:q].to_s.squish
      if @query.present?
        pattern = "%#{User.sanitize_sql_like(@query)}%"
        @results = User.where(platform_agent_of_id: nil)
          .where("users.nickname ILIKE :pattern OR users.email ILIKE :pattern", pattern: pattern)
          .includes(:community_honors, :community_support_access).order(:nickname, :email).limit(25).to_a
      end
    end
  end
end
