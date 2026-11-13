# "Quick Login — heyjyun": one personal account, chosen on the server, offered on the sign-in page.
#
# BILLIE_PERSONAL_ACCOUNT_EMAIL names the account. The address stays on the server and is
# never written into the page; the button shows only the account's nickname. Unset, the
# button is hidden.
#
# How the button authenticates:
# - Everywhere, including production: the account's own password (and two-factor code, when
#   it has one), checked by Devise with lockable's failed-attempt counting. No bypass.
# - Local development only: with BILLIE_DEV_PASSWORDLESS_LOGIN=true, a request from this
#   machine (loopback address) is signed in without a password. Both conditions are checked
#   on the server for every request; outside the development environment the flag is ignored.
module PersonalAccount
  def self.email
    ENV["BILLIE_PERSONAL_ACCOUNT_EMAIL"].to_s.strip.downcase.presence
  end

  # The configured account, while it can sign in. Never the shared demo or an agent.
  def self.user
    return unless (address = email)
    user = User.find_by(email: address, platform_agent_of_id: nil)
    user if user && !user.demo_account? && user.active_for_authentication?
  end

  def self.label(user)
    user.nickname.presence || I18n.t("billie.quick_access.personal.heading")
  end

  # Development-only passwordless sign-in for a request coming from this machine.
  def self.passwordless?(request)
    Rails.env.development? &&
      ENV["BILLIE_DEV_PASSWORDLESS_LOGIN"].to_s.strip.downcase == "true" &&
      request.local?
  end
end
