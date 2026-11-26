class User < ApplicationRecord
  include Users::Base
  include Roles::User

  attr_readonly :finance_owner_uid

  # Privileged routes require an operator grant for an existing account identity.
  # Email addresses can be submitted at signup and changed later.
  def developer?
    return false unless persisted? && platform_agent_of_id.nil? && finance_owner_uid.present?

    ENV.fetch("BILLIE_ADMIN_OWNER_IDS", "").split(",").any? do |owner_id|
      owner_id.strip.downcase == finance_owner_uid
    end
  end

  # The one place the nickname rules live on the server. services/identity-api/identity_api/validation.py
  # and clients/universal/src/services/profile.ts mirror them (same limit, same normalization).
  NICKNAME_MAX = 40
  # At least one letter, mark, number, punctuation or symbol: whitespace and invisible format
  # characters alone (e.g. a zero-width space) are not a nickname. Any script is welcome.
  NICKNAME_VISIBLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/

  # Set by the screens where a person edits their nickname, so clearing it there is refused
  # even for an older account that never had one.
  attr_accessor :editing_nickname

  has_one :finance_profile, class_name: "Finance::Profile", dependent: :destroy
  has_many :finance_statements, class_name: "Finance::Statement", dependent: :destroy
  has_many :finance_transactions, class_name: "Finance::Transaction", dependent: :destroy
  has_many :finance_insights, class_name: "Finance::Insight", dependent: :destroy
  has_many :finance_merchant_rules, class_name: "Finance::MerchantRule", dependent: :destroy
  has_many :finance_custom_categories, class_name: "Finance::CustomCategory", dependent: :delete_all
  has_many :finance_statement_drafts, class_name: "Finance::StatementDraft", dependent: :destroy
  has_many :finance_bank_accounts, class_name: "Finance::BankAccount", dependent: :destroy
  has_many :finance_local_database_reports, class_name: "Finance::LocalDatabaseReport", dependent: :delete_all
  has_many :finance_local_devices, class_name: "Finance::LocalDevice", dependent: :delete_all
  has_many :finance_local_database_audits, class_name: "Finance::LocalDatabaseAudit", dependent: :delete_all
  has_many :finance_command_executions, class_name: "Finance::CommandExecution", dependent: :delete_all
  has_many :finance_transaction_links, class_name: "Finance::TransactionLink", dependent: :delete_all
  has_many :finance_audit_events, class_name: "Finance::AuditEvent", dependent: :delete_all
  has_many :finance_organize_runs, class_name: "Finance::OrganizeRun", dependent: :delete_all
  has_many :finance_budgets, class_name: "Finance::Budget", dependent: :delete_all
  has_many :finance_recurring_rules, class_name: "Finance::RecurringRule", dependent: :delete_all
  has_many :finance_merchants, class_name: "Finance::Merchant", dependent: :delete_all
  has_many :finance_projects, class_name: "Finance::Project", dependent: :delete_all
  has_many :finance_tags, class_name: "Finance::Tag", dependent: :delete_all
  has_many :finance_category_settings, class_name: "Finance::CategorySetting", dependent: :delete_all
  has_many :finance_books, class_name: "Finance::Book", dependent: :delete_all
  has_many :finance_receipts, class_name: "Finance::Receipt", dependent: :destroy
  has_many :finance_receipt_matches, class_name: "Finance::ReceiptMatch", dependent: :delete_all
  has_many :finance_capture_tokens, class_name: "Finance::CaptureToken", dependent: :delete_all
  # Feature Library view preferences (not financial data; kept by "Delete my financial data").
  has_many :finance_module_preferences, class_name: "Finance::ModulePreference", dependent: :delete_all
  has_many :user_sessions, dependent: :delete_all
  # Honorary badges (not roles: they grant no permissions) and private support-payment access.
  has_many :community_honors, class_name: "Community::Honor", dependent: :destroy
  has_one :community_support_access, class_name: "Community::SupportAccess", dependent: :destroy
  validates :google_uid, length: {maximum: 255}, uniqueness: true, allow_nil: true
  before_validation :normalize_usage_region
  before_validation :normalize_nickname
  before_validation :normalize_cloud_database_name
  after_save { @usage_region_selection_attempted = false }
  # In the same transaction as the new password: every app and browser signs in again.
  after_update -> { UserSession.revoke_all!(self, reason: "password_changed") }, if: :saved_change_to_encrypted_password?
  validates :usage_region, presence: true, if: :usage_region_selection_required?
  validates :usage_region, inclusion: {in: UsageRegion::CODES}, allow_nil: true
  validates :nickname, length: {maximum: NICKNAME_MAX}
  validates :nickname, presence: true, if: :nickname_required?
  validate :nickname_has_no_control_characters
  validates :cloud_database_name, length: {maximum: 60}

  # What the website's session cookie holds. Devise stores the id and password salt; the third value is
  # a UserSession secret, so signing out on the server also ends copies of the cookie.
  def self.serialize_into_session(user)
    super + [UserSession.issue!(user, kind: "web").last]
  end

  # nil signs the browser out: unknown, expired or revoked sessions, and cookies from before UserSession.
  def self.serialize_from_session(key, salt, secret = nil)
    user = super(key, salt)
    user if user && UserSession.active_for(secret, kind: "web", user: user)
  end

  def usage_region=(value)
    @usage_region_selection_attempted = true
    super
  end

  # BillieWeather does not ask for a legal name; people choose a nickname instead.
  def name
    nickname.presence || email
  end

  # The name to greet someone by, or nil. Never falls back to the email address: a greeting
  # without a name reads better than "Good morning, jyun@example.com!".
  def preferred_name
    nickname.presence
  end

  # Older accounts (created while the nickname was optional) are asked, gently, to add one.
  def needs_nickname?
    platform_agent_of_id.nil? && nickname.blank?
  end

  # An API application has no nickname; its name is kept in first_name (Platform::Application).
  def full_name
    nickname.presence || (platform_agent_of_id ? first_name.to_s : "")
  end

  def details_provided?
    current_team&.name.present?
  end

  def formatted_email_address
    email
  end

  def needs_usage_region?
    platform_agent_of_id.nil? && usage_region.blank?
  end

  # Every account is a Member; Founding Member and Founding Patron stack on top.
  def community_badges
    ["member"] + Community::Honor::KINDS.select { |kind| active_honor_kinds.include?(kind) }
  end

  def founding_member?
    active_honor_kinds.include?("founding_member")
  end

  def founding_patron?
    active_honor_kinds.include?("founding_patron")
  end

  # Invited by an admin to see the personal payment QR codes.
  def support_payments_viewer?
    community_support_access&.active? || false
  end

  def support_payment_note
    Community.payment_note_for(self)
  end

  # Welcome mail is optional; account creation does not depend on paid email delivery.
  # The locale is captured now because the mail is delivered later, outside this request.
  def send_welcome_email
    return if Rails.env.production? && (ENV["POSTMARK_API_TOKEN"].blank? || ENV["MAIL_FROM"].blank?)
    WelcomeMailer.with(locale: I18n.locale.to_s).welcome(self).deliver_later
  rescue BilliePostmarkDelivery::Error
    Rails.logger.warn("Optional welcome email could not be delivered.")
  end
  # 🚅 add concerns above.

  # 🚅 add belongs_to associations above.

  # 🚅 add has_many associations above.

  # 🚅 add oauth providers above.

  # 🚅 add has_one associations above.

  # 🚅 add scopes above.

  # 🚅 add validations above.

  # 🚅 add callbacks above.

  # 🚅 add delegations above.

  # 🚅 add methods above.

  private

  def active_honor_kinds
    community_honors.loaded? ? community_honors.select(&:active?).map(&:kind) : community_honors.active.pluck(:kind)
  end

  def normalize_usage_region
    self[:usage_region] = usage_region.to_s.strip.upcase.presence
    self.usage_region_pending = false if usage_region.present?
  end

  def normalize_cloud_database_name
    self.cloud_database_name = cloud_database_name.to_s.gsub(/[[:cntrl:]]/, "").squish.presence
  end

  def normalize_nickname
    squished = nickname.to_s.squish
    self.nickname = squished.match?(NICKNAME_VISIBLE) ? squished : nil
  end

  # New accounts must choose a nickname; existing accounts without one keep working, but once a
  # nickname is set (or someone edits it in settings) it cannot be cleared back to blank.
  def nickname_required?
    platform_agent_of_id.nil? && (new_record? || editing_nickname || will_save_change_to_nickname?)
  end

  def nickname_has_no_control_characters
    errors.add(:nickname, :invalid) if nickname&.match?(/\p{Cc}/)
  end

  def usage_region_selection_required?
    # Legacy accounts can authenticate to complete their region. An explicit
    # blank selection is always rejected, including for those pending accounts.
    platform_agent_of_id.nil? && (new_record? || !usage_region_pending? || @usage_region_selection_attempted)
  end
end
