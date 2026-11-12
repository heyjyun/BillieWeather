# "Continue as …" on the sign-in page. After someone really signs in (password, Google or a
# completed Google sign-up), this browser keeps a signed, HTTP-only cookie holding only their
# user id. The sign-in page uses it to offer that account first.
#
# It is a hint, never a credential: choosing "Continue as …" only fills in the email address.
# The person still proves who they are with their password (and two-factor code) or Google.
# The demo account is never remembered.
module RememberedAccount
  COOKIE = :billie_remembered_account
  LIFETIME = 1.year

  def self.remember(cookies, user, secure:)
    return unless rememberable?(user)
    cookies.signed[COOKIE] = {value: {"id" => user.id}, expires: LIFETIME.from_now, httponly: true, same_site: :lax, secure: secure}
  end

  def self.forget(cookies)
    cookies.delete(COOKIE)
  end

  # The remembered user, or nil when there is none or it can no longer sign in.
  def self.find(cookies)
    payload = cookies.signed[COOKIE]
    id = payload.is_a?(Hash) ? payload["id"] : nil
    return unless id.is_a?(Integer)
    user = User.find_by(id: id, platform_agent_of_id: nil)
    user if rememberable?(user) && user.active_for_authentication?
  end

  def self.rememberable?(user)
    user.is_a?(User) && user.persisted? && user.platform_agent_of_id.nil? && !user.demo_account?
  end

  # What the button shows: the chosen nickname, otherwise a masked email (j•••@example.com).
  def self.label(user)
    user.nickname.presence || masked_email(user.email)
  end

  def self.masked_email(email)
    local, domain = email.to_s.split("@", 2)
    return email.to_s if local.blank? || domain.blank?
    "#{local[0]}•••@#{domain}"
  end
end
