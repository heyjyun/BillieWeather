module Finance
  # Automatic categorization. No external service and no data leaves the app:
  #   1. rules this person taught us by correcting a transaction (Finance::MerchantRule),
  #   2. built-in transfer detection, positive amounts as Income,
  #   3. built-in merchant and keyword lists,
  #   4. otherwise "Uncategorized".
  class Categorizer
    def self.words(*list)
      /\b(?:#{list.map { |word| Regexp.escape(word) }.join("|")})\b/i
    end

    # Transfers are left out of income/spending totals, so keep this list narrow: wrongly
    # calling a real payment a transfer would silently hide it from the totals.
    TRANSFERS = words("transfer", "payment thank you", "credit card payment", "opening balance", "balance forward")

    # Order matters: the first match wins, so more specific lists come first
    # (for example "uber eats" is Food, not Transport; "amazon web services" is Business, not Shopping).
    RULES = {
      "Housing" => words("rent", "mortgage", "property management", "hoa", "landlord", "apartment", "lease", "home insurance", "renters insurance", "homeowners"),
      "Food & dining" => words("grocery", "groceries", "supermarket", "restaurant", "coffee", "cafe", "dining", "whole foods", "trader joe", "starbucks",
        "kroger", "safeway", "aldi", "publix", "wegmans", "costco wholesale", "mcdonald", "burger king", "wendy", "taco bell", "chipotle", "domino", "pizza",
        "kfc", "dunkin", "panera", "doordash", "grubhub", "uber eats", "ubereats", "instacart", "bakery", "bistro", "diner", "sushi", "deli", "boba", "bar & grill",
        "7-eleven", "food", "kitchen", "tea house", "noodle", "ramen", "taqueria"),
      "Transport" => words("uber", "lyft", "transit", "metro", "parking", "fuel", "gas station", "shell", "exxon", "chevron", "bp", "mobil", "ventra", "cta", "mta",
        "amtrak", "airlines", "airways", "airline", "southwest", "jetblue", "toll", "ezpass", "e-zpass", "zipcar", "car wash", "auto repair", "dmv", "greyhound", "bus"),
      "Utilities" => words("electric", "electricity", "water bill", "internet", "utility", "utilities", "comcast", "verizon", "at&t", "phone bill",
        "xfinity", "spectrum", "t-mobile", "tmobile", "sewer", "waste management", "trash", "natural gas", "gas bill", "comed", "pg&e", "wireless", "cable"),
      "Health" => words("pharmacy", "medical", "doctor", "hospital", "dental", "cvs", "walgreens", "rite aid", "clinic", "urgent care", "optical", "vision",
        "therapy", "labcorp", "quest diagnostics", "health insurance", "gym", "fitness", "yoga", "planet fitness", "dentist", "physician"),
      # Kept to the template's original list. Many tools (cloud, design, AI) are as likely to be
      # personal as business, so those are left for the person to decide and remember.
      "Business" => words("office supplies", "software", "adobe", "notion", "github", "hosting", "business insurance"),
      # Matched before Shopping so an AWS bill is not filed as Amazon shopping; it stays Uncategorized.
      "Uncategorized" => words("aws", "amazon web services"),
      "Shopping" => words("amazon", "target", "walmart", "shopping", "clothing", "apparel", "ebay", "etsy", "best buy", "home depot", "lowe's", "ikea", "nike",
        "adidas", "zara", "h&m", "uniqlo", "macy", "nordstrom", "costco", "apple store", "apple.com", "store", "mart", "outlet", "boutique")
    }.freeze

    # Words banks add to descriptions that say nothing about the merchant.
    NOISE_WORDS = %w[pos purchase debit credit card checkcard visa mastercard ach web online payment pmt recurring withdrawal deposit sq tst pp
      www com inc llc ltd co the and of at in on].freeze

    # A short, stable name for a merchant: letters only, noise removed, first two words.
    # "STARBUCKS STORE #1234 SEATTLE WA" and "Starbucks Store 99 Portland OR" share "starbucks store".
    def self.merchant_key(description)
      tokens = description.to_s.downcase.gsub(/[^\p{L}&\s]/, " ").split
      tokens = tokens.reject { |token| NOISE_WORDS.include?(token) || token.length < 2 }
      key = tokens.first(2).join(" ")
      ((key.length >= 3 || key.match?(/[^\x00-\x7F]/)) && !key.empty?) ? key : nil
    end

    def initialize(user:)
      @user = user
    end

    def categorize(description, amount)
      key = self.class.merchant_key(description)
      learned = key && learned_rules[[key, amount.positive?]]
      return learned if learned
      return "Transfers" if TRANSFERS.match?(description)
      return "Income" if amount.positive?
      RULES.find { |_category, pattern| pattern.match?(description) }&.first || "Uncategorized"
    end

    # Re-run today's rules over this account's Uncategorized transactions, so newly
    # learned merchants and improved keyword lists also clean up older imports.
    # Only Uncategorized rows are touched; categories a person chose are never changed.
    def self.recategorize_uncategorized!(user:)
      categorizer = new(user: user)
      changes = Hash.new { |hash, category| hash[category] = [] }
      Transaction.where(user_id: user.id, category: "Uncategorized").find_each do |transaction|
        category = categorizer.categorize(transaction.description, transaction.amount)
        changes[category] << transaction.id unless category == "Uncategorized"
      end
      changes.sum { |category, ids| update_category(ids, category) }
    end

    # Used after a person corrects one transaction: same merchant, same direction.
    def self.apply_rule_to_uncategorized(user:, key:, income:, category:)
      direction = income ? "amount > 0" : "amount <= 0"
      ids = Transaction.where(user_id: user.id, category: "Uncategorized").where(direction)
        .pluck(:id, :description).filter_map { |id, description| id if merchant_key(description) == key }
      update_category(ids, category)
    end

    def self.update_category(ids, category)
      return 0 if ids.empty?
      attributes = {category: category, updated_at: Time.current}
      attributes[:tax_review] = true if category == "Business"
      Transaction.where(id: ids).update_all(attributes)
    end
    private_class_method :update_category

    private

    def learned_rules
      @learned_rules ||= MerchantRule.where(user_id: @user.id).pluck(:merchant_key, :income, :category)
        .to_h { |key, income, category| [[key, income], category] }
    end
  end
end
