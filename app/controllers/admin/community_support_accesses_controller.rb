module Admin
  # Invite a friend to see the personal payment QR codes, or withdraw that invitation.
  class CommunitySupportAccessesController < BaseController
    before_action :find_member

    def create
      ::Community::SupportAccess.grant!(user: @member, by: current_user)
      redirect_to admin_community_user_path(@member), status: :see_other, notice: t("billie.community.admin.access_granted")
    end

    def destroy
      @member.community_support_access&.revoke!(by: current_user)
      redirect_to admin_community_user_path(@member), status: :see_other, notice: t("billie.community.admin.access_revoked")
    end
  end
end
