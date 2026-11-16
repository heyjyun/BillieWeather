module Finance
  # Decides the economic kind of an IMPORTED row once its category is decided (person, file,
  # remembered rule, keyword lists): Finance::Domain.kind_for_categorized, the same rule as
  # packages/finance-core kindForCategorized. Transfer-like kinds carry the Transfers category name.
  module EntryClassifier
    module_function

    # Returns [kind, category].
    def classify(description:, amount:, account_type:, category:, user_id: nil)
      category = category.presence || "Uncategorized"
      income = (user_id && !Transaction::CATEGORIES.include?(category) && Transaction.income_category?(user_id, category)) ? [category] : []
      kind = Domain.kind_for_categorized(amount: amount, account_type: account_type, description: description, category: category, income_categories: income)
      [kind, Transaction.category_for_kind(kind, category)]
    end
  end
end
