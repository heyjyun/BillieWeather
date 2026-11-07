module Finance
  # "Remember my change": when someone recategorizes a transaction, later transactions
  # from the same merchant (and the same direction, money in or out) get that category
  # automatically. Rules belong to one account and are never shared.
  class MerchantRule < ActiveRecord::Base
    self.table_name = "finance_merchant_rules"

    belongs_to :user

    validates :merchant_key, presence: true, length: {maximum: 100}
    validates :category, inclusion: {in: Transaction::CATEGORIES - ["Uncategorized"]}
    validates :income, inclusion: {in: [true, false]}

    # Saves the rule and applies it to this account's other Uncategorized transactions
    # from the same merchant. Returns the number of other transactions updated, or nil
    # when no rule could be made (no usable merchant name, or category "Uncategorized").
    def self.remember!(user:, description:, amount:, category:)
      key = Categorizer.merchant_key(description)
      return nil if key.nil? || category == "Uncategorized"

      income = amount.to_d.positive?
      begin
        rule = find_or_initialize_by(user_id: user.id, merchant_key: key, income: income)
        rule.category = category
        rule.save!
      rescue ActiveRecord::RecordNotUnique
        retry
      end
      Categorizer.apply_rule_to_uncategorized(user: user, key: key, income: income, category: category)
    end
  end
end
