module Finance
  # Values a person typed or confirmed for a receipt (web review form, the apps, the API), validated and
  # converted to columns. Blank means "unknown" (nil), never zero. Raises Ledger::Invalid with field codes.
  module ReceiptFields
    MONEY = %w[total subtotal tax tip discount].freeze

    module_function

    def clean(user, fields)
      fields = fields.to_h.stringify_keys.slice(*Receipt::EDITABLE)
      errors = []
      cleaned = {}
      fields.each do |name, raw|
        value = raw.is_a?(String) ? raw.strip : raw
        value = nil if value == ""
        cleaned[name.to_sym] = case name
        when "merchant_name" then value&.to_s&.squish&.first(200)
        when "purchased_on"
          value.nil? ? nil : (Date.iso8601(value.to_s) rescue errors << "purchased_on_invalid")
        when "purchased_at_time"
          (value.nil? || value.to_s.match?(/\A[0-2]\d:[0-5]\d\z/)) ? value : errors << "purchased_at_time_invalid"
        when *MONEY
          next cleaned[name.to_sym] = nil if value.nil?
          amount = BigDecimal(value.to_s.delete(",").delete_prefix("$"), exception: false)
          (amount&.finite? && amount == amount.round(2) && amount.abs < 10**13) ? ((%w[total tip discount].include?(name)) ? amount.abs : amount) : errors << "#{name}_invalid"
        when "currency"
          (value.nil? || value.to_s.upcase.match?(/\A[A-Z]{3}\z/)) ? value&.to_s&.upcase : errors << "currency_invalid"
        when "direction" then Receipt::DIRECTIONS.include?(value) ? value : errors << "direction_invalid"
        when "payment_method" then (value.nil? || Receipt::PAYMENT_METHODS.include?(value)) ? value : errors << "payment_method_invalid"
        when "card_last4" then (value.nil? || value.to_s.match?(/\A\d{4}\z/)) ? value&.to_s : errors << "card_last4_invalid"
        when "receipt_number" then value&.to_s&.first(64)
        when "category"
          next cleaned[:category] = nil if value.nil?
          (Transaction::CATEGORIES.include?(value) || user.finance_custom_categories.exists?(name: value)) ? value : errors << "category_invalid"
        when "bank_account_id"
          next cleaned[:bank_account_id] = nil if value.nil?
          user.finance_bank_accounts.exists?(id: value) ? value.to_i : errors << "account_not_found"
        end
      end
      raise Ledger::Invalid, errors.uniq if errors.any?
      cleaned
    end
  end
end
