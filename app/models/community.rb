# Community support: honorary badges and voluntary, person-to-person support.
# Nothing here processes payments; admins verify transfers by hand.
module Community
  # The QR codes shown in the support modal, in display order (2×2 grid).
  PAYMENT_METHODS = %w[alipay wechat_pay zelle venmo].freeze
  PAYMENT_METHOD_LABELS = {
    "alipay" => "Alipay — 支付宝",
    "wechat_pay" => "WeChat Pay — 微信支付",
    "zelle" => "Zelle",
    "venmo" => "Venmo"
  }.freeze

  # Payment QR codes stay hidden until receiving support has been confirmed as allowed.
  # Off unless SUPPORT_PAYMENTS_ENABLED is explicitly true/1/yes/on; anything else, including typos, keeps it off.
  def self.payments_enabled?
    %w[true 1 yes on].include?(ENV["SUPPORT_PAYMENTS_ENABLED"].to_s.strip.downcase)
  end

  # Where people without a payment-note field tell the admin about their transfer.
  # Optional; set SUPPORT_CONTACT_EMAIL to show an email link in the support modal.
  def self.support_contact_email
    email = ENV["SUPPORT_CONTACT_EMAIL"].to_s.strip
    email if email.match?(URI::MailTo::EMAIL_REGEXP)
  end

  # "{nickname} donation" — the note admins match against incoming transfers.
  # Never falls back to the email address.
  def self.payment_note_for(user)
    nickname = user&.nickname.to_s.squish
    return nil if nickname.blank?
    "#{nickname} donation"
  end

  def self.payment_method_label(key)
    PAYMENT_METHOD_LABELS.fetch(key.to_s) { I18n.t("billie.community.payment_methods.other") }
  end
end
