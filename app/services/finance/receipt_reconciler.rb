module Finance
  # Applies receipt matching decisions to the ledger (docs/architecture/receipt-capture-and-reconciliation.md §5–6).
  #
  #   process(receipt)        Match → Verify for one receipt: an exact, unambiguous match to an existing
  #                           entry is linked automatically when the receipt is confident and in the book
  #                           currency; everything else (probable/ambiguous candidates, uncertain or
  #                           incomplete extraction, no candidate) waits for a person. A receipt is never
  #                           turned into a new entry automatically (product decision 3, 2026-11-23):
  #                           a person reviews the suggested entry and confirms it with record!.
  #   after_import(ids)       Re-runs open receipts against bank rows that just arrived (ImportPlan).
  #   confirm / reject / undo The person's decisions: "Confirm match", "Keep separate", "Undo".
  #   record!(receipt)        Records the receipt as an entry (entry_origin "receipt").
  #
  # One purchase counts once: when a receipt that was recorded as an entry is matched to the bank's row,
  # the receipt entry is superseded (kept, not live) by the bank row; undoing the match makes it live
  # again. Bank rows are never edited, superseded or deleted here (the database also refuses to
  # supersede them). Every change runs inside the person's row lock — the lock imports take — and
  # writes an audit event.
  class ReceiptReconciler
    Invalid = Ledger::Invalid
    CANDIDATE_KINDS = %w[expense refund income].freeze

    def initialize(user, actor: "user")
      @user = user
      @actor = actor
    end

    def process(receipt)
      locked do
        receipt = own_receipt(receipt)
        next receipt if %w[duplicate possible_duplicate dismissed].include?(receipt.status)
        next refresh(receipt) if receipt.matches.confirmed.exists?
        unless receipt.complete?
          receipt.matches.suggested.delete_all
          next refresh(receipt)
        end
        result = ReceiptMatcher.match(matcher_receipt(receipt), candidates_for(receipt))
        if result.level == "exact" && result.best.ids.length == 1 && auto_link_allowed?(receipt)
          link!(receipt, [Transaction.where(user_id: @user.id).find(result.best.ids.first)], result.best, decided_by: "auto")
        else
          # Not linked without a person: the candidates (an exact one included) become suggestions.
          suggest!(receipt, result.proposals)
        end
        refresh(receipt)
      end
    end

    # Bank (or any imported) rows were just inserted: give every open receipt dated around them another look.
    # Called by ImportPlan#insert! inside the importer's lock and transaction.
    def after_import(transaction_ids)
      dates = Transaction.where(user_id: @user.id, id: transaction_ids).pick(Arel.sql("MIN(booked_on)"), Arel.sql("MAX(booked_on)"))
      return 0 if dates.nil? || dates.first.nil?
      window = (dates.first - ReceiptMatcher::POSTING_AFTER)..(dates.last + ReceiptMatcher::POSTING_BEFORE)
      receipts = Receipt.where(user_id: @user.id, status: Receipt::OPEN_STATUSES, purchased_on: window).where.not(total: nil)
        .where.not(id: ReceiptMatch.confirmed.where(user_id: @user.id).select(:receipt_id)).order(:id).to_a
      receipts.each { |receipt| process(receipt) }
      receipts.length
    end

    # "Confirm match" (also turns an automatic match into a person-verified one).
    def confirm(match)
      locked do
        match = own_match(match)
        receipt = match.receipt
        group = match.group_key ? receipt.matches.where(group_key: match.group_key).to_a : [match]
        entries = group.map(&:finance_transaction)
        if match.status == "confirmed"
          group.each { |item| item.update!(decided_by: "user", decided_at: Time.current) }
          audit("update", receipt, {"verification" => "auto_matched"}, {"verification" => "verified"})
        else
          raise Invalid, "match_not_open" unless group.all? { |item| item.status == "suggested" }
          raise Invalid, "already_matched" if receipt.matches.confirmed.exists?
          link!(receipt, entries, nil, decided_by: "user", existing: group)
        end
        refresh(receipt)
      end
    end

    # "Keep separate": these are different purchases. Remembered, so the pair is never suggested again.
    # The receipt then waits for the person to record it as its own entry (record!); nothing is created here.
    def reject(match)
      locked do
        match = own_match(match)
        raise Invalid, "match_not_open" unless match.status == "suggested"
        receipt = match.receipt
        group = match.group_key ? receipt.matches.suggested.where(group_key: match.group_key).to_a : [match]
        group.each { |item| item.update!(status: "rejected", decided_by: "user", decided_at: Time.current) }
        audit("update", receipt, {"match" => "suggested"}, {"match" => "rejected", "transaction_ids" => group.map(&:transaction_id)})
        refresh(receipt)
      end
    end

    # Reverses a confirmed match (automatic or by a person): the link is rejected, the receipt entry it
    # had superseded counts again, and the receipt goes back to waiting for its bank row.
    def undo(match)
      locked do
        match = own_match(match)
        raise Invalid, "match_not_confirmed" unless match.status == "confirmed"
        receipt = match.receipt
        group = receipt.matches.confirmed.to_a
        group.each { |item| item.update!(status: "rejected", decided_by: "user", decided_at: Time.current) }
        entry = receipt.entry
        if entry&.superseded? && group.map(&:transaction_id).include?(entry.superseded_by_id)
          before = {"superseded_by_id" => entry.superseded_by_id}
          entry.update_columns(superseded_by_id: nil, updated_at: Time.current)
          audit("unlink", entry, before, {"superseded_by_id" => nil})
        end
        audit("unlink", receipt, {"match" => "confirmed", "transaction_ids" => group.map(&:transaction_id)}, {"match" => "rejected"})
        touch
        refresh(receipt)
      end
    end

    # A rejected pair can be offered again ("Reconsider").
    def reconsider(match)
      locked do
        match = own_match(match)
        raise Invalid, "match_not_rejected" unless match.status == "rejected"
        match.update!(status: "suggested", decided_by: "user", decided_at: nil, level: (match.level == "exact") ? "probable" : match.level)
        audit("update", match.receipt, {"match" => "rejected"}, {"match" => "suggested"})
        refresh(match.receipt)
      end
    end

    # Links a receipt to an entry a person chose by hand (no matcher suggestion).
    def link_manually(receipt, entry)
      locked do
        receipt = own_receipt(receipt)
        entry = Transaction.live.where(user_id: @user.id).find(entry.is_a?(Transaction) ? entry.id : entry)
        raise Invalid, "already_matched" if receipt.matches.confirmed.exists?
        raise Invalid, "entry_has_receipt" if ReceiptMatch.confirmed.where(user_id: @user.id, transaction_id: entry.id).exists?
        raise Invalid, "entry_is_receipt" if entry.from_receipt?
        raise Invalid, "kind_invalid" unless CANDIDATE_KINDS.include?(entry.kind)
        link!(receipt, [entry], nil, decided_by: "user", level: "manual")
        refresh(receipt)
      end
    end

    # Records the receipt as an expense (or refund) entry, for a cash purchase or one the bank has not
    # posted yet. Returns the entry.
    def record!(receipt, inside_lock: false)
      run = -> {
        receipt = own_receipt(receipt)
        raise Invalid, "already_recorded" if receipt.entry && receipt.entry.deleted_at.nil?
        raise Invalid, "receipt_incomplete" unless receipt.complete?
        raise Invalid, "currency_mismatch" unless book_currency?(receipt)
        account = account_for(receipt)
        category = receipt.category.presence || suggested_category(receipt)
        entry = Ledger.new(@user).create({
          kind: receipt.refund? ? "refund" : "expense", amount: receipt.total.to_s("F"), booked_on: receipt.purchased_on.iso8601,
          occurred_at_time: receipt.purchased_at_time, account_id: account&.id, category: category,
          description: receipt.merchant_name.presence || I18n.t("billie.receipts.untitled"),
          note: [I18n.t("billie.receipts.entry_note"), receipt.receipt_number.presence && "##{receipt.receipt_number}"].compact.join(" "),
          category_source: receipt.reviewed?("category") ? "user" : "auto"
        }, actor: @actor, origin: "receipt")
        receipt.update!(entry: entry, bank_account: receipt.bank_account || account)
        audit("create", receipt, {}, {"transaction_id" => entry.id})
        refresh(receipt)
        entry
      }
      inside_lock ? run.call : locked { run.call }
    end

    # "It's a different purchase": a possible duplicate becomes its own receipt and goes through matching.
    def not_duplicate(receipt)
      locked do
        receipt = own_receipt(receipt)
        raise Invalid, "not_a_duplicate" unless %w[possible_duplicate duplicate].include?(receipt.status)
        before = {"status" => receipt.status, "duplicate_of_id" => receipt.duplicate_of_id}
        receipt.update!(status: "needs_review", duplicate_of: nil)
        audit("update", receipt, before, {"status" => "needs_review", "duplicate_of_id" => nil})
        process(receipt)
      end
    end

    # "Yes, it's a copy": kept for reference, never counted.
    def mark_duplicate(receipt)
      locked do
        receipt = own_receipt(receipt)
        raise Invalid, "not_a_duplicate" unless receipt.status == "possible_duplicate"
        receipt.update!(status: "duplicate")
        audit("update", receipt, {"status" => "possible_duplicate"}, {"status" => "duplicate"})
        receipt
      end
    end

    # Hides a receipt that is not needed (a copy, a test photo). Refused while it supports the ledger.
    def dismiss(receipt)
      locked do
        receipt = own_receipt(receipt)
        raise Invalid, "receipt_in_use" if receipt.matches.confirmed.exists? || (receipt.entry && receipt.entry.deleted_at.nil?)
        before = {"status" => receipt.status}
        receipt.matches.suggested.delete_all
        receipt.update!(status: "dismissed", duplicate_of: nil)
        audit("update", receipt, before, {"status" => "dismissed"})
        receipt
      end
    end

    def reopen(receipt)
      locked do
        receipt = own_receipt(receipt)
        raise Invalid, "not_dismissed" unless receipt.status == "dismissed"
        receipt.update!(status: "needs_review")
        audit("update", receipt, {"status" => "dismissed"}, {"status" => "needs_review"})
        process(receipt)
      end
    end

    # A person corrected or confirmed fields. The receipt entry (if any, and not set aside) follows the
    # corrected amount, date and merchant; matching runs again.
    def update_fields(receipt, fields)
      locked do
        receipt = own_receipt(receipt)
        cleaned = ReceiptFields.clean(@user, fields)
        before = receipt.attributes.slice(*cleaned.keys.map(&:to_s)).transform_values { |value| value.is_a?(BigDecimal) ? value.to_s("F") : value&.to_s }
        receipt.assign_attributes(cleaned)
        receipt.confirmed_fields = Array(receipt.confirmed_fields) | cleaned.keys.map(&:to_s)
        receipt.reviewed_at = Time.current
        receipt.save!
        after = receipt.attributes.slice(*cleaned.keys.map(&:to_s)).transform_values { |value| value.is_a?(BigDecimal) ? value.to_s("F") : value&.to_s }
        audit("update", receipt, before, after)
        entry = receipt.entry
        if entry && entry.deleted_at.nil? && !entry.superseded? && receipt.complete?
          changes = {amount: receipt.total.to_s("F"), booked_on: receipt.purchased_on.iso8601, description: receipt.merchant_name.presence || entry.description}
          changes[:category] = receipt.category if receipt.category.present?
          changes[:account_id] = receipt.bank_account_id if receipt.bank_account_id
          Ledger.new(@user).update(entry, changes, actor: @actor)
        end
        receipt.matches.suggested.delete_all
        receipt.matches.confirmed.exists? ? refresh(receipt) : process(receipt)
      end
    end

    # The bank row of a matched receipt went to the trash: the receipt entry it superseded counts again.
    def release_superseded(entry)
      Transaction.where(user_id: @user.id, superseded_by_id: entry.id).find_each do |superseded|
        superseded.update_columns(superseded_by_id: nil, updated_at: Time.current)
        audit("update", superseded, {"superseded_by_id" => entry.id}, {"superseded_by_id" => nil})
      end
    end

    # The bank row came back from the trash: the receipt entries of its confirmed receipts are set aside again.
    def resupersede(entry)
      ReceiptMatch.confirmed.where(user_id: @user.id, transaction_id: entry.id).includes(receipt: :entry).find_each do |match|
        superseded = match.receipt.entry
        next unless superseded && superseded.deleted_at.nil? && !superseded.superseded? && superseded.id != entry.id
        superseded.update_columns(superseded_by_id: entry.id, updated_at: Time.current)
        audit("update", superseded, {"superseded_by_id" => nil}, {"superseded_by_id" => entry.id})
      end
    end

    private

    def locked(&block)
      User.find(@user.id).with_lock(&block)
    rescue ActiveRecord::RecordNotFound
      raise Invalid, "not_found"
    rescue ActiveRecord::RecordNotUnique
      raise Invalid, "entry_has_receipt"
    end

    def own_receipt(receipt) = Receipt.where(user_id: @user.id).find(receipt.is_a?(Receipt) ? receipt.id : receipt)

    def own_match(match) = ReceiptMatch.where(user_id: @user.id).find(match.is_a?(ReceiptMatch) ? match.id : match)

    def profile = @profile ||= Profile.find_by(user_id: @user.id)

    def book_currency?(receipt)
      receipt.currency.nil? || profile.nil? || receipt.currency == profile.currency
    end

    # Deterministic gate for linking without a person, on top of the matcher's "exact" level: merchant,
    # date and total are trusted (OCR confidence or a person's confirmation, no blocking issues), the
    # receipt is in the book's currency, and it is not already linked. No model score decides this.
    def auto_link_allowed?(receipt) = receipt.complete? && receipt.confident? && book_currency?(receipt) && !receipt.matches.confirmed.exists?

    def matcher_receipt(receipt)
      {amount_minor: receipt.total_minor, direction: receipt.direction, currency: receipt.currency, date: receipt.purchased_on, merchant: receipt.merchant_name,
       card_last4: receipt.card_last4, receipt_number: receipt.receipt_number, tip_minor: receipt.tip && (receipt.tip * 100).to_i, confident: receipt.confident?}
    end

    # Live entries that could be this purchase's bank row. Receipt entries are never candidates (they are
    # the receipt's own kind of evidence); entries already evidenced by another receipt are marked.
    def candidates_for(receipt)
      window = (receipt.purchased_on - ReceiptMatcher::POSTING_BEFORE)..(receipt.purchased_on + ReceiptMatcher::POSTING_AFTER)
      entries = Transaction.live.where(user_id: @user.id, booked_on: window, kind: CANDIDATE_KINDS, excluded: false).where.not(entry_origin: "receipt")
        .includes(:bank_account, statement: :bank_account).order(:id).limit(500).to_a
      taken = ReceiptMatch.confirmed.where(user_id: @user.id, transaction_id: entries.map(&:id)).where.not(receipt_id: receipt.id).pluck(:transaction_id).to_set
      rejected = receipt.matches.rejected.pluck(:transaction_id).to_set
      entries.map do |entry|
        account = entry.bank_account || entry.statement&.bank_account
        {id: entry.id, amount_minor: (entry.amount * 100).to_i, currency: account&.currency.presence || profile&.currency, date: entry.booked_on,
         description: entry.original_description, kind: entry.kind, account_last4: account&.last4.presence, reference: nil,
         has_receipt: taken.include?(entry.id), rejected: rejected.include?(entry.id)}
      end
    end

    def suggest!(receipt, proposals)
      keep = []
      proposals.first(5).each do |proposal|
        group = (proposal.ids.length > 1) ? SecureRandom.uuid : nil
        proposal.ids.each do |id|
          match = receipt.matches.find_or_initialize_by(transaction_id: id)
          next if match.persisted? && match.status != "suggested"
          match.assign_attributes(user: @user, status: "suggested", level: proposal.level, score: proposal.score.clamp(0, 100), reasons: proposal.reasons,
            group_key: group, decided_by: "auto", decided_at: nil)
          match.save!
          keep << match.id
        end
      end
      receipt.matches.suggested.where.not(id: keep).delete_all
    end

    # Confirms receipt ↔ entries and sets the receipt's own entry aside for the bank row.
    def link!(receipt, entries, proposal, decided_by:, existing: nil, level: nil)
      now = Time.current
      matches = existing || entries.map do |entry|
        receipt.matches.find_or_initialize_by(transaction_id: entry.id).tap do |match|
          match.assign_attributes(user: @user, level: level || proposal&.level || "manual", score: (proposal&.score || 0).clamp(0, 100),
            reasons: proposal&.reasons || [], group_key: (entries.length > 1) ? SecureRandom.uuid : nil)
        end
      end
      group_key = matches.first.group_key
      matches.each { |match| match.update!(status: "confirmed", decided_by: decided_by, decided_at: now, group_key: group_key) }
      receipt.matches.suggested.where.not(id: matches.map(&:id)).delete_all
      bank = entries.first
      own = receipt.entry
      if own && own.deleted_at.nil? && !own.superseded? && entries.none? { |entry| entry.id == own.id }
        before = {"superseded_by_id" => nil}
        own.update_columns(superseded_by_id: bank.id, updated_at: now)
        audit("update", own, before, {"superseded_by_id" => bank.id})
        carry_category(own, bank)
      end
      audit("link", receipt, {}, {"transaction_ids" => entries.map(&:id), "decided_by" => decided_by, "level" => matches.first.level, "reasons" => matches.first.reason_codes})
      touch
    end

    # A category a person chose on the receipt entry moves to the bank row unless the bank row has its own.
    def carry_category(from, to)
      return unless from.locked?("category") && !to.locked?("category") && from.category != to.category && !to.transfer_like?
      Ledger.new(@user).update(to, {category: from.category}, actor: @actor)
    rescue Ledger::Invalid
      nil
    end

    def account_for(receipt)
      return receipt.bank_account if receipt.bank_account
      accounts = @user.finance_bank_accounts.where(archived_at: nil)
      if receipt.card_last4.present?
        by_card = accounts.where(last4: receipt.card_last4).to_a
        return by_card.first if by_card.one?
      end
      if receipt.cash?
        cash = accounts.where(account_type: "cash").to_a
        return cash.first if cash.one?
      end
      nil
    end

    def suggested_category(receipt)
      category = Categorizer.new(user: @user).categorize(receipt.merchant_name.to_s, -receipt.total.abs, account_type: nil)
      (category == "Income" || category == "Transfers") ? "Uncategorized" : category
    end

    def refresh(receipt)
      receipt.refresh_status!
      receipt.reload
    end

    def audit(action, record, before, after)
      AuditEvent.record!(user: @user, action: action, subject: record, actor: @actor, summary: record.try(:display_name) || record.try(:description),
        changes: {"before" => before, "after" => after})
    end

    def touch = Profile.where(user_id: @user.id).touch_all
  end
end
