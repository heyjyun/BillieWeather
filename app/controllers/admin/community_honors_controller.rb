module Admin
  # Grant or revoke an honorary badge. Founding Patron is granted only here, after an
  # admin has checked the actual transfer outside BillieWeather; opening the support
  # modal or copying a payment note never changes anyone's badges.
  class CommunityHonorsController < BaseController
    before_action :find_member

    def create
      attributes = params.require(:honor).permit(:kind, :payment_method, :confirmed_at, :note)
      kind = attributes[:kind].to_s
      patron = kind == "founding_patron"
      ::Community::Honor.grant!(user: @member, kind: kind, by: current_user,
        payment_method: (attributes[:payment_method] if patron),
        confirmed_at: (parse_admin_time(attributes[:confirmed_at]) if patron),
        note: attributes[:note])
      redirect_to admin_community_user_path(@member), status: :see_other,
        notice: t("billie.community.admin.granted_flash", badge: t("billie.community.badges.#{kind}"))
    rescue ActiveRecord::RecordInvalid => error
      redirect_to admin_community_user_path(@member), status: :see_other, alert: error.record.errors.full_messages.to_sentence
    end

    def revoke
      honor = @member.community_honors.active.find(params[:id])
      honor.revoke!(by: current_user, reason: params.dig(:honor, :revoke_reason))
      redirect_to admin_community_user_path(@member), status: :see_other,
        notice: t("billie.community.admin.revoked_flash", badge: t("billie.community.badges.#{honor.kind}"))
    rescue ActiveRecord::RecordInvalid => error
      redirect_to admin_community_user_path(@member), status: :see_other, alert: error.record.errors.full_messages.to_sentence
    end
  end
end
