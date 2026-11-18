module Finance
  # How a batch of parsed statement rows becomes entries (every import path uses it: CSV, reviewed PDF,
  # a statement sent from a device):
  #   1. classify each row's kind with the account type (EntryClassifier): a refund or a card
  #      repayment on a credit card is never income;
  #   2. compare with what is already stored for the same account (DuplicateDetector): automatic
  #      duplicates are skipped, possible duplicates are kept and linked for a person to decide;
  #   3. insert in bulk with provenance (original_description, kind, account, origin);
  #   4. match the new rows against captured receipts (ReceiptReconciler#after_import).
  # Call inside the caller's per-user lock and database transaction.
  class ImportPlan
    attr_reader :rows, :skipped, :flagged

    # `categorizer`: re-decides the category of rows whose category did not come from the file once the
    # account type is known (money in on a credit card is a refund or a repayment, not Income).
    def initialize(user:, rows:, bank_account: nil, origin: "import", category_source: "auto", dedupe: true, categorizer: nil)
      @user = user
      @bank_account = bank_account
      @origin = origin
      @dates = rows.map { |row| row[:booked_on] }.minmax.then { |first, last| first..last } unless rows.empty?
      account_type = bank_account&.account_type
      custom = rows.any? { |row| row[:category].present? && !Transaction::CATEGORIES.include?(row[:category]) }
      income_categories = custom ? CategorySetting.where(user_id: user.id, category_kind: "income").pluck(:name).map(&:downcase).to_set : Set.new
      verdicts = dedupe ? DuplicateDetector.call(stored_rows, rows.map { |row| detector_row(row) }) : rows.map { nil }
      @rows = []
      @skipped = 0
      @flagged = []
      rows.zip(verdicts).each do |row, verdict|
        if verdict&.result == "duplicate"
          @skipped += 1
          next
        end
        from_file = row[:file_category]
        row = row.except(:file_category)
        if categorizer && account_type && !from_file
          row = row.merge(category: categorizer.categorize(row[:description], row[:amount], account_type: account_type))
        end
        source = row[:category_source] || (from_file ? "file" : category_source)
        kind, category = EntryClassifier.classify(description: row[:description], amount: row[:amount], account_type: account_type,
          category: row[:category], user_id: user.id, income_categories: income_categories)
        # Device transfers already carry the person's explicit classification and bank evidence.
        kind = row[:kind] || kind
        category = Transaction.category_for_kind(kind, row[:category] || category)
        @rows << row.merge(kind: kind, category: category, original_description: row[:original_description] || row[:description], entry_origin: origin,
          category_source: source, bank_account_id: bank_account&.id,
          tax_review: row[:tax_review] || category == "Business", excluded: row[:excluded] || false)
        @flagged << [@rows.length - 1, verdict.of] if verdict&.result == "review"
      end
    end

    def empty?
      @rows.empty?
    end

    # Inserts the planned rows for `statement` and records suggested duplicate links. Returns the new ids.
    def insert!(statement)
      now = Time.current
      ids = []
      @rows.each_slice(500) do |batch|
        result = Transaction.insert_all!(batch.map do |attributes|
          attributes.merge(user_id: @user.id, statement_id: statement&.id, created_at: now, updated_at: now)
        end, returning: [:id])
        ids.concat(result.rows.flatten)
      end
      @flagged.each do |index, existing_id|
        TransactionLink.create!(user: @user, link_type: "duplicate_of", from_transaction_id: ids[index], to_transaction_id: existing_id,
          status: "suggested", decided_by: "auto")
      end
      # Deduplicate against receipts (one purchase, one entry): bank rows that arrive for purchases already
      # captured from a receipt are matched; exact matches set the receipt entry aside, others wait for a person.
      ReceiptReconciler.new(@user, actor: "import").after_import(ids) if ids.any? && Receipt.where(user_id: @user.id, status: Receipt::OPEN_STATUSES).exists?
      ids
    end

    private

    def stored_rows
      DuplicateDetector.stored_rows(@user, dates: @dates, account_id: @bank_account&.id)
    end

    def detector_row(row)
      {account: @bank_account&.id, date: row[:booked_on], amount: row[:amount], description: row[:original_description] || row[:description], reference: nil}
    end
  end
end
