module Finance
  # This parser only populates the normal manual form. The user reviews and saves through Ledger.
  module QuickEntry
    PATTERN = /\A(spent|paid|received|earned|expense|income|支出|收入|花了|收到)\s+(\d{1,12}(?:[.,]\d{1,2})?)\s+(.+)\z/i
    INCOME = %w[received earned income 收入 收到].freeze

    def self.parse(input)
      return unless input.is_a?(String) && input.length <= 195
      match = PATTERN.match(input.strip.gsub(/[ \t]+/, " "))
      return unless match
      direction, amount, description = match.captures
      description = description.sub(/\A(?:on|from|for)\s+/i, "").strip
      amount = amount.tr(",", ".")
      return if description.empty? || description.length > 160 || BigDecimal(amount).zero?
      {kind: INCOME.include?(direction.downcase) ? "income" : "expense", amount: amount, description: description}
    end
  end
end
