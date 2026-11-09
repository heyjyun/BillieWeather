class User < ApplicationRecord
  include Users::Base
  include Roles::User

  has_one :finance_profile, class_name: "Finance::Profile", dependent: :destroy
  has_many :finance_statements, class_name: "Finance::Statement", dependent: :destroy
  has_many :finance_transactions, class_name: "Finance::Transaction", dependent: :destroy
  has_many :finance_insights, class_name: "Finance::Insight", dependent: :destroy
  has_many :finance_merchant_rules, class_name: "Finance::MerchantRule", dependent: :destroy
  has_many :finance_statement_drafts, class_name: "Finance::StatementDraft", dependent: :destroy
  has_many :finance_bank_accounts, class_name: "Finance::BankAccount", dependent: :destroy
  validates :google_uid, length: {maximum: 255}, uniqueness: true, allow_nil: true
  before_validation :normalize_usage_region
  before_validation :normalize_nickname
  after_save { @usage_region_selection_attempted = false }
  validates :usage_region, presence: true, if: :usage_region_selection_required?
  validates :usage_region, inclusion: {in: UsageRegion::CODES}, allow_nil: true
  validates :nickname, length: {maximum: 40}

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

  def needs_usage_region?
    platform_agent_of_id.nil? && usage_region.blank?
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

  def normalize_usage_region
    self[:usage_region] = usage_region.to_s.strip.upcase.presence
    self.usage_region_pending = false if usage_region.present?
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
