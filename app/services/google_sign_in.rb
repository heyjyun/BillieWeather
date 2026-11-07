class GoogleSignIn
  class Error < StandardError; end

  class LinkRequired < Error
    attr_reader :identity

    def initialize(user:, uid:, email:)
      @identity = {"user_id" => user.id, "uid" => uid, "email" => email, "expires_at" => 10.minutes.from_now.to_i}
      super("This email already has an account. Log in with your existing password once to connect Google.")
    end
  end

  attr_reader :created

  def self.configured?
    ENV["GOOGLE_CLIENT_ID"].to_s.strip.present? && ENV["GOOGLE_CLIENT_SECRET"].to_s.strip.present?
  end

  def initialize(auth:, current_user: nil, allow_signup: true, create_team: true)
    @auth = auth
    @current_user = current_user
    @allow_signup = allow_signup
    @create_team = create_team
    @created = false
  end

  def call
    raise Error, "Google sign-in is currently unavailable. Please use email and password." unless self.class.configured?
    read_verified_identity!
    linked = User.find_by(google_uid: @uid)
    if linked
      if @current_user && @current_user.id != linked.id
        raise Error, "Sign out before using a different Google account."
      end
      verify_login_allowed!(linked)
      return linked
    end

    existing = User.find_for_database_authentication(email: @email)
    if existing
      verify_login_allowed!(existing)
      raise LinkRequired.new(user: existing, uid: @uid, email: @email)
    end
    raise Error, "Sign out before creating an account with a different email." if @current_user
    raise Error, "New account registration is not available. Please use an invited account." unless @allow_signup

    user = User.transaction do
      password = Devise.friendly_token(48)
      user = User.create!(email: @email, google_uid: @uid, password: password, password_confirmation: password,
        first_name: profile_name("first_name", "given_name"), last_name: profile_name("last_name", "family_name"))
      user.create_default_team if @create_team
      user
    end
    @created = true
    user
  rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
    # Concurrent signups must never bind an identity to a different existing user.
    raise Error, "Google sign-in could not complete. Please try again or log in with your existing password."
  end

  # Called only after Devise has authenticated the account's password (and OTP,
  # when enabled). The short-lived pending identity came from a verified callback.
  def self.connect_after_password_sign_in!(user:, identity:)
    return false unless configured?
    return false unless identity.is_a?(Hash) && identity["expires_at"].is_a?(Integer) && identity["expires_at"] > Time.current.to_i
    return false unless identity["user_id"] == user.id && identity["email"] == user.email.to_s.strip.downcase
    uid = identity["uid"]
    return false unless uid.is_a?(String) && uid.length.between?(1, 255) && !uid.match?(/\s/)
    user.with_lock do
      return false unless user.active_for_authentication?
      return false if user.google_uid.present? && user.google_uid != uid
      return false if User.where(google_uid: uid).where.not(id: user.id).exists?
      user.update!(google_uid: uid)
    end
    true
  rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
    false
  end

  private

  def read_verified_identity!
    raise Error, "Google did not return a verified identity. Please try again." unless @auth.respond_to?(:dig) && @auth["provider"] == "google_oauth2"
    claims = @auth.dig("extra", "id_info")
    @uid = @auth["uid"]
    verified = claims.is_a?(Hash) && claims["email_verified"].in?([true, "true"])
    unless verified && @uid.is_a?(String) && @uid.length.between?(1, 255) && !@uid.match?(/\s/) && claims["sub"] == @uid
      raise Error, "Google did not return a verified identity. Please try again."
    end
    @email = claims["email"].to_s.strip.downcase
    info_email = @auth.dig("info", "email").to_s.strip.downcase
    unless @email.length <= 254 && Devise.email_regexp.match?(@email) && info_email == @email
      raise Error, "Google did not return a verified email address. Please try again."
    end
  end

  def profile_name(info_key, claim_key)
    (@auth.dig("info", info_key).presence || @auth.dig("extra", "id_info", claim_key)).to_s.strip.truncate(80, omission: "")
  end

  def verify_login_allowed!(user)
    raise Error, "This account cannot sign in right now. Please use the email login page." unless user.active_for_authentication?
    if user.otp_required_for_login?
      raise Error, "This account requires an authentication code. Please sign in with email, password, and your authentication code."
    end
    if user.google_uid.present? && user.google_uid != @uid
      raise Error, "This account is connected to a different Google account. Please use your existing login."
    end
  end
end
