class GoogleSignIn
  class Error < StandardError; end

  class LinkRequired < Error
    attr_reader :identity

    def initialize(user:, uid:, email:)
      @identity = {"user_id" => user.id, "uid" => uid, "email" => email, "expires_at" => 10.minutes.from_now.to_i}
      super(I18n.t("billie.auth.google_link_required"))
    end
  end

  class RegionRequired < Error
    attr_reader :identity

    def initialize(uid:, email:, first_name:, last_name:)
      # Only the verified identity is retained in the encrypted browser session.
      # Google access/refresh tokens are never kept while waiting for a region.
      @identity = {"uid" => uid, "email" => email, "first_name" => first_name, "last_name" => last_name,
                   "expires_at" => 10.minutes.from_now.to_i}
      super(I18n.t("billie.google_region.intro"))
    end
  end

  attr_reader :created

  def self.configured?
    ENV["GOOGLE_CLIENT_ID"].to_s.strip.present? && ENV["GOOGLE_CLIENT_SECRET"].to_s.strip.present?
  end

  def initialize(auth:, current_user: nil, allow_signup: true, create_team: true, usage_region: nil)
    @auth = auth
    @current_user = current_user
    @allow_signup = allow_signup
    @create_team = create_team
    @usage_region = usage_region.to_s.strip.upcase.presence
    @created = false
  end

  def call
    raise Error, I18n.t("billie.auth.google_service_unavailable") unless self.class.configured?
    read_verified_identity!
    linked = User.find_by(google_uid: @uid)
    if linked
      if @current_user && @current_user.id != linked.id
        raise Error, I18n.t("billie.auth.google_sign_out_first")
      end
      verify_login_allowed!(linked)
      return linked
    end

    existing = User.find_for_database_authentication(email: @email)
    if existing
      verify_login_allowed!(existing)
      raise LinkRequired.new(user: existing, uid: @uid, email: @email)
    end
    raise Error, I18n.t("billie.auth.google_sign_out_before_signup") if @current_user
    raise Error, I18n.t("billie.auth.registration_unavailable") unless @allow_signup

    unless @usage_region
      raise RegionRequired.new(uid: @uid, email: @email,
        first_name: profile_name("first_name", "given_name"), last_name: profile_name("last_name", "family_name"))
    end
    raise Error, I18n.t("billie.google_region.invalid") unless UsageRegion::CODES.include?(@usage_region)

    user = User.transaction do
      password = Devise.friendly_token(48)
      user = User.create!(email: @email, google_uid: @uid, password: password, password_confirmation: password,
        first_name: profile_name("first_name", "given_name"), last_name: profile_name("last_name", "family_name"),
        usage_region: @usage_region)
      user.create_default_team if @create_team
      user
    end
    @created = true
    user
  rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
    # Concurrent signups must never bind an identity to a different existing user.
    raise Error, I18n.t("billie.auth.google_failed")
  end

  # Rebuild the minimal auth input only from a short-lived, verified session identity.
  # The completion controller never accepts identity fields from form parameters.
  def self.pending_signup_auth(identity)
    return unless identity.is_a?(Hash) && identity["expires_at"].is_a?(Integer) && identity["expires_at"] > Time.current.to_i
    return if identity["expires_at"] > 10.minutes.from_now.to_i
    uid = identity["uid"]
    email = identity["email"]
    return unless uid.is_a?(String) && uid.length.between?(1, 255) && !uid.match?(/\s/)
    return unless email.is_a?(String) && email.length <= 254 && email == email.strip.downcase && Devise.email_regexp.match?(email)
    return unless %w[first_name last_name].all? { |key| identity[key].is_a?(String) && identity[key].length <= 80 }

    {"provider" => "google_oauth2", "uid" => uid,
     "info" => {"email" => email, "first_name" => identity["first_name"], "last_name" => identity["last_name"]},
     "extra" => {"id_info" => {"sub" => uid, "email" => email, "email_verified" => true}}}
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
    raise Error, I18n.t("billie.auth.google_unverified_identity") unless @auth.respond_to?(:dig) && @auth["provider"] == "google_oauth2"
    claims = @auth.dig("extra", "id_info")
    @uid = @auth["uid"]
    verified = claims.is_a?(Hash) && claims["email_verified"].in?([true, "true"])
    unless verified && @uid.is_a?(String) && @uid.length.between?(1, 255) && !@uid.match?(/\s/) && claims["sub"] == @uid
      raise Error, I18n.t("billie.auth.google_unverified_identity")
    end
    @email = claims["email"].to_s.strip.downcase
    info_email = @auth.dig("info", "email").to_s.strip.downcase
    unless @email.length <= 254 && Devise.email_regexp.match?(@email) && info_email == @email
      raise Error, I18n.t("billie.auth.google_unverified_email")
    end
  end

  def profile_name(info_key, claim_key)
    (@auth.dig("info", info_key).presence || @auth.dig("extra", "id_info", claim_key)).to_s.strip.truncate(80, omission: "")
  end

  def verify_login_allowed!(user)
    raise Error, I18n.t("billie.auth.account_unavailable") unless user.active_for_authentication?
    if user.otp_required_for_login?
      raise Error, I18n.t("billie.auth.authentication_code_required")
    end
    if user.google_uid.present? && user.google_uid != @uid
      raise Error, I18n.t("billie.auth.google_other_account")
    end
  end
end
