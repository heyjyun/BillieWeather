# Labels and tones for receipt capture, matching and verification (docs/architecture/receipt-capture-and-reconciliation.md §4).
module ReceiptsHelper
  TONES = {
    "verified" => nil, "auto_matched" => nil, "matched" => nil, "bank_record" => "bw-badge-neutral", "cash" => "bw-badge-neutral",
    "pending_bank_match" => "bw-badge-neutral", "needs_review" => "bw-badge-review", "possible_duplicate" => "bw-badge-review",
    "duplicate" => "bw-badge-neutral", "amount_mismatch" => "bw-badge-failed", "foreign_currency" => "bw-badge-review",
    "entry_in_trash" => "bw-badge-neutral", "dismissed" => "bw-badge-neutral", "missing_receipt" => "bw-badge-review",
    "superseded" => "bw-badge-neutral", "unverified_manual" => "bw-badge-neutral"
  }.freeze

  def receipt_badge(state, id: nil)
    content_tag(:span, t("billie.receipts.verification.#{state}"), class: ["bw-badge", TONES[state]].compact.join(" "), id: id)
  end

  # "Confirmed" (a person checked it), "Uncertain" (OCR below the trust threshold) or "Missing".
  def receipt_field_state(receipt, column)
    return :confirmed if receipt.reviewed?(column)
    return :missing if receipt.public_send(column).nil?
    confidence = receipt.field_confidence(column)
    (confidence.nil? || confidence >= Finance::ReceiptParser::CONFIDENT) ? :read : :uncertain
  end

  def receipt_field_tag(receipt, column)
    state = receipt_field_state(receipt, column)
    tone = {confirmed: "bw-badge", read: "bw-badge bw-badge-neutral", uncertain: "bw-badge bw-badge-review", missing: "bw-badge bw-badge-failed"}.fetch(state)
    confidence = receipt.field_confidence(column)
    label = t("billie.receipts.field_state.#{state}")
    label = "#{label} · #{(confidence * 100).round}%" if state == :read || (state == :uncertain && confidence.to_f.positive?)
    content_tag(:span, label, class: tone, data: {field_state: state})
  end

  def receipt_reasons(codes)
    Array(codes).map { |code| t("billie.receipts.reasons.#{code}", default: code.to_s.humanize) }.to_sentence
  end

  def receipt_issue(code) = t("billie.receipts.issues.#{code}", default: code.to_s.humanize)

  # What a ledger entry's evidence says about it (transaction detail page).
  def entry_verification(entry)
    matches = entry.receipt_matches.to_a
    confirmed = matches.select { |match| match.status == "confirmed" }
    if entry.from_receipt?
      return "superseded" if entry.superseded?
      receipt = entry.recorded_receipt
      return "cash" if receipt&.cash?
      return receipt&.suggested_matches&.any? ? "needs_review" : "pending_bank_match"
    end
    return confirmed.first.receipt.verification if confirmed.any?
    return "needs_review" if matches.any? { |match| match.status == "suggested" }
    return ((entry.tax_review? && entry.kind == "expense") ? "missing_receipt" : "bank_record") if entry.statement_id
    "unverified_manual"
  end
end
