module Finance
  # Decides the economic kind of an IMPORTED row once its category is decided (person, file,
  # remembered rule, keyword lists): Finance::Domain.kind_for_categorized, the same rule as
  # packages/finance-core kindForCategorized. Category kinds come from the person's tree
  # (Finance::CategoryTree): any category in the transfer subtree is a transfer, any in an income
  # tree is income. Transfer-like kinds carry a category from the transfer subtree.
  module EntryClassifier
    module_function

    # Returns [kind, category]. `tree`: the person's Finance::CategoryTree (loaded once per import).
    def classify(description:, amount:, account_type:, category:, user_id: nil, tree: nil)
      category = category.presence || Transaction::UNCATEGORIZED
      tree ||= user_id && CategoryTree.new(user_id)
      kind = if tree
        Domain.kind_for_categorized(amount: amount, account_type: account_type, description: description, category: category,
          income_categories: tree.income_names, transfer_categories: tree.transfer_names)
      else
        Domain.kind_for_categorized(amount: amount, account_type: account_type, description: description, category: category)
      end
      [kind, Transaction.category_for_kind(kind, category, tree: tree)]
    end
  end
end
