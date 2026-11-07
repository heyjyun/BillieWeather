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
end
