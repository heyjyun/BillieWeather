module Finance
  class Profile < ActiveRecord::Base
    self.table_name = "finance_profiles"

    CURRENCIES = %w[USD CAD EUR GBP AUD NZD SGD HKD CNY JPY].freeze
    TAX_PROFILES = %w[personal self_employed business].freeze

    belongs_to :user

    before_validation { self.currency = currency.to_s.strip.upcase }

    validates :user_id, uniqueness: true
    validates :currency, inclusion: {in: CURRENCIES}
    validates :current_balance, numericality: {greater_than: -10**13, less_than: 10**13}
    validates :tax_country, length: {maximum: 80}
    validates :tax_profile, inclusion: {in: TAX_PROFILES}, allow_blank: true
    validate :currency_matches_existing_statements
    validate :balance_has_cent_precision

    private

    def balance_has_cent_precision
      value = BigDecimal(current_balance_before_type_cast.to_s, exception: false)
      if value&.finite? && value != value.round(2)
        errors.add(:current_balance, "must have at most two decimal places")
      end
    end

    def currency_matches_existing_statements
      return unless currency_changed? && persisted?
      if Finance::Statement.where(user_id: user_id).where.not(currency: currency).exists?
        errors.add(:currency, "cannot change while statements in another currency exist")
      end
    end
  end
end
