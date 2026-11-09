module CommunityHelper
  BADGE_ICONS = {"member" => "badge", "founding_member" => "badge", "founding_patron" => "crown"}.freeze
  TIERS = %w[member founding_member founding_patron].freeze
  # [benefit, planned?, included for Member / Founding Member / Founding Patron]
  BENEFITS = [
    ["core_features", false, [true, true, true]],
    ["community_badge", false, [true, true, true]],
    ["early_previews", true, [false, true, true]],
    ["feedback_voting", true, [false, true, true]],
    ["aladdins_lamp", true, [false, true, true]],
    ["supporter_recognition", false, [false, false, true]]
  ].freeze

  # One honorary badge. Member is green, Founding Member blue, Founding Patron gold.
  def community_badge(kind)
    content_tag(:span, class: "bw-honor-badge bw-honor-#{kind.to_s.dasherize}") do
      safe_join([finance_icon(BADGE_ICONS.fetch(kind.to_s, "badge"), size: 14), t("billie.community.badges.#{kind}")])
    end
  end

  # What the support modal shows for the current visitor. Real QR codes only in :ready:
  # payments enabled, signed in, invited by an admin, nickname set, and at least one
  # method enabled on Admin → Payment Methods.
  def support_dialog_locals
    @support_dialog_locals ||= begin
      state = support_dialog_state
      locals = {state: state, payment_methods: nil, payment_note: nil, support_contact_email: nil}
      if state == :ready
        locals.merge!(payment_methods: Community::PaymentMethod.available_for_display,
          payment_note: current_user.support_payment_note, support_contact_email: Community.support_contact_email)
      end
      locals
    end
  end

  def community_badges(user)
    content_tag(:span, class: "bw-honor-badges") { safe_join(user.community_badges.map { |kind| community_badge(kind) }) }
  end

  private

  def support_dialog_state
    return :coming_soon unless Community.payments_enabled?
    return :sign_in unless user_signed_in?
    return :not_invited unless current_user.support_payments_viewer?
    return :nickname_required if current_user.support_payment_note.blank?
    return :coming_soon unless Community::PaymentMethod.available_for_display.any?
    :ready
  end
end
