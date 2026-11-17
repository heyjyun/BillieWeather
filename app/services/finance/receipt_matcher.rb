module Finance
  # Port of packages/finance-core/src/receipt/match.ts (receipt ↔ entry matching and receipt duplicates).
  # Both replay packages/finance-core/fixtures/receipts/match-cases.json. Pure: no database access;
  # Finance::ReceiptReconciler builds the inputs and applies the decisions.
  #
  # Levels: exact (the only one ever applied without a person), probable, ambiguous, none. Never a
  # match on the amount alone, never across currencies by amount, never a transfer or card payment.
  module ReceiptMatcher
    POSTING_BEFORE = 1
    POSTING_AFTER = 7
    EXACT_DAYS = 3
    TIP_LIMIT = 0.3
    PURCHASE_KINDS = %w[expense].freeze
    REFUND_KINDS = %w[refund income].freeze

    # receipt: {amount_minor:, direction:, currency:, date:, merchant:, card_last4:, receipt_number:, tip_minor:, confident:}
    # candidate: {id:, amount_minor:, currency:, date:, description:, kind:, account_last4:, reference:, has_receipt:, rejected:}
    Proposal = Struct.new(:level, :ids, :score, :reasons, :day_offset, keyword_init: true)
    Result = Data.define(:level, :best, :proposals)

    module_function

    def day_number(value) = (value.is_a?(Date) ? value : Date.iso8601(value.to_s)).jd

    def normalize_id(value) = value.to_s.gsub(/[^A-Za-z0-9]/, "").upcase

    def compare(a, b)
      [-a.score, a.day_offset.abs, a.ids.first.to_s.rjust(20, "0")] <=> [-b.score, b.day_offset.abs, b.ids.first.to_s.rjust(20, "0")]
    end

    def match(receipt, candidates)
      receipt = receipt.to_h.transform_keys(&:to_sym)
      kinds = (receipt[:direction] == "refund") ? REFUND_KINDS : PURCHASE_KINDS
      receipt_day = day_number(receipt[:date])
      number = normalize_id(receipt[:receipt_number])
      card = receipt[:card_last4].presence
      eligible = candidates.map { |candidate| candidate.to_h.transform_keys(&:to_sym) }.select do |candidate|
        next false if candidate[:rejected] || candidate[:has_receipt] || !kinds.include?(candidate[:kind].to_s)
        next false if (receipt[:direction] == "purchase") ? candidate[:amount_minor] >= 0 : candidate[:amount_minor] <= 0
        offset = day_number(candidate[:date]) - receipt_day
        next false if offset < -POSTING_BEFORE || offset > POSTING_AFTER
        next false if card && candidate[:account_last4].present? && card != candidate[:account_last4]
        true
      end

      proposals = []
      eligible.each do |candidate|
        offset = day_number(candidate[:date]) - receipt_day
        similarity = MerchantIdentity.similarity(receipt[:merchant], candidate[:description])
        same_currency = receipt[:currency].blank? || candidate[:currency].blank? || receipt[:currency] == candidate[:currency]
        magnitude = candidate[:amount_minor].abs
        reference_match = number.length >= 4 && number == normalize_id(candidate[:reference])
        last4_match = card.present? && candidate[:account_last4].present? && card == candidate[:account_last4]
        reasons = []
        day_reason = if offset.zero? then "same_day" elsif offset.positive? then "posted_later" else "posted_earlier" end

        unless same_currency
          next if similarity.nil? || similarity < 0.8
          reasons.push("currency_differs", (similarity == 1) ? "merchant_same" : "merchant_similar", day_reason)
          proposals << Proposal.new(level: "ambiguous", ids: [candidate[:id]], score: (30 * similarity + [0, 20 - 3 * offset.abs].max).round, reasons: reasons, day_offset: offset)
          next
        end

        amount_equal = magnitude == receipt[:amount_minor]
        tip_like = !amount_equal && receipt[:direction] == "purchase" && receipt[:tip_minor].nil? && magnitude > receipt[:amount_minor] &&
          magnitude - receipt[:amount_minor] <= (receipt[:amount_minor] * TIP_LIMIT).round
        next unless amount_equal || tip_like
        next if !similarity.nil? && similarity < 0.3 && !reference_match
        next if tip_like && (similarity.nil? || similarity < 0.8)

        reasons << (amount_equal ? "amount_equal" : "amount_differs_tip")
        reasons << if similarity.nil? then "merchant_unknown" elsif similarity == 1 then "merchant_same" elsif similarity >= 0.8 then "merchant_similar" else "merchant_weak" end
        reasons << day_reason
        reasons << "card_last4_match" if last4_match
        reasons << "receipt_number_match" if reference_match
        reasons << "low_confidence" unless receipt[:confident]

        score = [100, (amount_equal ? 40 : 20) + (30 * (similarity || 0)).round + [0, 20 - 3 * [0, offset].max].max - (offset.negative? ? 5 : 0) +
          (last4_match ? 10 : 0) + (reference_match ? 20 : 0)].min
        strong = !similarity.nil? && similarity >= 0.8
        level = if amount_equal && reference_match then "exact"
        elsif amount_equal && strong && offset >= 0 && offset <= EXACT_DAYS && receipt[:confident] then "exact"
        elsif amount_equal && strong then "probable"
        elsif amount_equal && !similarity.nil? && similarity >= 0.5 && last4_match then "probable"
        else "ambiguous"
        end
        proposals << Proposal.new(level: level, ids: [candidate[:id]], score: score, reasons: reasons, day_offset: offset)
      end

      if proposals.none? { |proposal| proposal.reasons.include?("amount_equal") } && receipt[:direction] == "purchase"
        parts = eligible.select do |candidate|
          (MerchantIdentity.similarity(receipt[:merchant], candidate[:description]) || 0) >= 0.8 &&
            (receipt[:currency].blank? || candidate[:currency].blank? || receipt[:currency] == candidate[:currency]) && candidate[:amount_minor].abs < receipt[:amount_minor]
        end
        parts.each_with_index do |first, i|
          parts[(i + 1)..].each do |second|
            next unless first[:amount_minor].abs + second[:amount_minor].abs == receipt[:amount_minor]
            offset = [day_number(first[:date]), day_number(second[:date])].max - receipt_day
            proposals << Proposal.new(level: "ambiguous", ids: [first[:id], second[:id]], score: 60 + [0, 20 - 3 * [0, offset].max].max, reasons: %w[split_payment merchant_similar], day_offset: offset)
          end
        end
      end

      proposals.sort! { |a, b| compare(a, b) }
      strong = proposals.select { |proposal| %w[exact probable].include?(proposal.level) }
      if strong.length >= 2
        strong.each do |proposal|
          proposal.level = "ambiguous"
          proposal.reasons << "multiple_candidates" unless proposal.reasons.include?("multiple_candidates")
        end
      elsif strong.length == 1 && strong.first.level == "exact"
        rivals = proposals.reject { |proposal| proposal.equal?(strong.first) }.select { |proposal| proposal.reasons.include?("amount_equal") && !proposal.reasons.include?("merchant_unknown") }
        if rivals.any? && !strong.first.reasons.include?("receipt_number_match")
          strong.first.level = "probable"
          strong.first.reasons << "similar_candidates"
        end
      end
      rank = {"exact" => 0, "probable" => 1, "ambiguous" => 2}
      proposals = proposals.each_with_index.sort_by { |proposal, index| [rank[proposal.level], index] }.map(&:first)
      best = proposals.first
      Result.new(level: best ? best.level : "none", best: best, proposals: proposals)
    end

    # incoming/existing: {id:, sha256:, amount_minor:, date:, time:, merchant:, receipt_number:, direction:}
    # Returns {kind: "same_file"|"same_receipt"|"possible", of: id} or nil.
    def duplicate(incoming, existing)
      incoming = incoming.to_h.transform_keys(&:to_sym)
      existing = existing.map { |receipt| receipt.to_h.transform_keys(&:to_sym) }
      if incoming[:sha256].present?
        same = existing.find { |receipt| receipt[:sha256].present? && receipt[:sha256] == incoming[:sha256] }
        return {kind: "same_file", of: same[:id]} if same
      end
      number = normalize_id(incoming[:receipt_number])
      possible = nil
      existing.each do |receipt|
        next if receipt[:id] == incoming[:id]
        next if (receipt[:direction] || "purchase") != (incoming[:direction] || "purchase")
        similarity = MerchantIdentity.similarity(incoming[:merchant], receipt[:merchant])
        other = normalize_id(receipt[:receipt_number])
        if number.length >= 4 && other.length >= 4
          if number == other && (similarity.nil? || similarity >= 0.8) && (incoming[:amount_minor].nil? || receipt[:amount_minor].nil? || incoming[:amount_minor] == receipt[:amount_minor])
            return {kind: "same_receipt", of: receipt[:id]}
          end
          next
        end
        next if incoming[:amount_minor].nil? || incoming[:date].nil? || incoming[:amount_minor] != receipt[:amount_minor] || incoming[:date].to_s != receipt[:date].to_s
        next if similarity.nil? || similarity < 0.8
        next if incoming[:time].present? && receipt[:time].present? && incoming[:time] != receipt[:time]
        possible ||= receipt
      end
      possible && {kind: "possible", of: possible[:id]}
    end
  end
end
