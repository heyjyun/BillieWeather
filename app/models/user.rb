class User < ApplicationRecord
  include Users::Base
  include Roles::User

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
  # Honorary badges (not roles: they grant no permissions) and private support-payment access.
  has_many :community_honors, class_name: "Community::Honor", dependent: :destroy
  has_one :community_support_access, class_name: "Community::SupportAccess", dependent: :destroy
  validates :google_uid, length: {maximum: 255}, uniqueness: true, allow_nil: true
  before_validation :normalize_usage_region
  before_validation :normalize_nickname
  before_validation :normalize_cloud_database_name
  after_save { @usage_region_selection_attempted = false }
  validates :usage_region, presence: true, if: :usage_region_selection_required?
  validates :usage_region, inclusion: {in: UsageRegion::CODES}, allow_nil: true
  validates :nickname, length: {maximum: 40}
  validates :cloud_database_name, length: {maximum: 60}
  validate :reserved_demo_email

  # Set only by DemoAccount::Seeder, the one place allowed to create the Example Account.
  attr_accessor :demo_identity_allowed

  def usage_region=(value)
    @usage_region_selection_attempted = true
    super
  end

  # BillieWeather does not ask for a legal name; people choose an optional nickname instead.
  def name
    nickname.presence || email
  end

  def full_name
    nickname.to_s
  end

  def details_provided?
    current_team&.name.present?
  end

  def formatted_email_address
    email
  end

  # The shared, read-only Example Account (see DemoAccount). Uses email_was, like developer?,
  # so an unsaved email change cannot make an account look like the demo or stop being it.
  def demo_account?
    DemoAccount.email?(email_was || email)
  end

  # The demo is never an administrator, whatever DEVELOPER_EMAILS says.
  def developer?
    return false if demo_account?
    super
  end

  # The demo has no usable password: it is signed in only by DemoSessionsController. Refusing
  # here covers the website form, the apps' API and the "change password" check.
  def valid_password?(password)
    return false if demo_account?
    super
  end

  def send_reset_password_instructions
    return if demo_account?
    super
  end

  # Many people share the demo; do not record their sign-in times and IP addresses on it.
  def update_tracked_fields!(request)
    return if demo_account?
    super
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
  def send_welcome_email
    return if Rails.env.production? && (ENV["POSTMARK_API_TOKEN"].blank? || ENV["MAIL_FROM"].blank?)
    super
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

  def reserved_demo_email
    return if persisted? && !will_save_change_to_email?
    return unless DemoAccount.email?(email)
    return if demo_identity_allowed
    errors.add(:email, :exclusion)
  end

  def normalize_cloud_database_name
    self.cloud_database_name = cloud_database_name.to_s.gsub(/[[:cntrl:]]/, "").squish.presence
  end

  def normalize_nickname
    self.nickname = nickname.to_s.squish.presence
  end

  def usage_region_selection_required?
    # Legacy accounts can authenticate to complete their region. An explicit
    # blank selection is always rejected, including for those pending accounts.
    platform_agent_of_id.nil? && (new_record? || !usage_region_pending? || @usage_region_selection_attempted)
  end
end
