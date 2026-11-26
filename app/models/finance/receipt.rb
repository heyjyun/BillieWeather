module Finance
  # A captured receipt: evidence for a purchase, never a transaction by itself
  # (docs/architecture/receipt-capture-and-reconciliation.md).
  #
  # - `extraction` holds what OCR/parsing inferred, field by field with confidences; it is never
  #   treated as bank data. The normalized columns (merchant_name, purchased_on, total, …) start
  #   from the extraction and become authoritative only for fields a person confirmed
  #   (`confirmed_fields`).
  # - `entry` is the ledger entry recorded from this receipt (entry_origin "receipt"), when the
  #   purchase has no bank row yet or was paid in cash.
  # - `matches` link the receipt to the ledger entries it supports (usually the bank's row).
  # - The original file lives in private database storage (never a public URL).
  class Receipt < ActiveRecord::Base
    self.table_name = "finance_receipts"

    STATUSES = %w[needs_review possible_duplicate duplicate pending_bank_match cash matched dismissed].freeze
    OPEN_STATUSES = %w[needs_review pending_bank_match].freeze
    SOURCES = %w[camera upload shortcut app email manual].freeze
    PAYMENT_METHODS = %w[card cash mobile other].freeze
    DIRECTIONS = %w[purchase refund].freeze
    CONTENT_TYPES = %w[image/jpeg image/png image/heic image/heif image/webp application/pdf].freeze
    MAX_BYTES = 10.megabytes
    EDITABLE = %w[merchant_name purchased_on purchased_at_time total subtotal tax tip discount currency direction payment_method card_last4 receipt_number category bank_account_id].freeze

    belongs_to :user
    belongs_to :entry, class_name: "Finance::Transaction", foreign_key: :transaction_id, optional: true
    belongs_to :bank_account, class_name: "Finance::BankAccount", optional: true
    belongs_to :duplicate_of, class_name: "Finance::Receipt", optional: true
    has_many :matches, class_name: "Finance::ReceiptMatch", inverse_of: :receipt, dependent: :delete_all
    has_one_attached :file, service: :private_database, dependent: :purge

    validates :status, inclusion: {in: STATUSES}
    validates :source, inclusion: {in: SOURCES}
    validates :direction, inclusion: {in: DIRECTIONS}
    validates :payment_method, inclusion: {in: PAYMENT_METHODS}, allow_nil: true
    validates :currency, format: {with: /\A[A-Z]{3}\z/}, allow_nil: true
    validates :card_last4, format: {with: /\A\d{4}\z/}, allow_nil: true
    validates :purchased_at_time, format: {with: /\A[0-2]\d:[0-5]\d\z/}, allow_nil: true
    validates :merchant_name, length: {maximum: 200}
    validates :receipt_number, length: {maximum: 64}
    validates :total, :tip, :discount, numericality: {greater_than_or_equal_to: 0, less_than: 10**13}, allow_nil: true
    validates :subtotal, :tax, numericality: {greater_than: -10**13, less_than: 10**13}, allow_nil: true
    validates :byte_size, numericality: {greater_than: 0, less_than_or_equal_to: MAX_BYTES}, allow_nil: true
    validate :same_owner_as_references
    validate :category_is_known

    scope :visible, -> { where.not(status: "dismissed") }
    scope :newest_first, -> { order(created_at: :desc, id: :desc) }

    def confirmed_matches = matches.select { |match| match.status == "confirmed" }

    def suggested_matches = matches.select { |match| match.status == "suggested" }

    def matched_entries = confirmed_matches.map(&:finance_transaction)

    # Whether a person confirmed (or typed) every field automation relies on.
    def reviewed?(field = nil)
      fields = field ? [field.to_s] : %w[merchant_name purchased_on total]
      (fields - Array(confirmed_fields)).empty?
    end

    # The minimum a receipt needs before it can be recorded or matched.
    def complete?
      total.present? && total.positive? && purchased_on.present?
    end

    # Merchant, date and total are trusted: OCR confidence ≥ RECEIPT_CONFIDENT without blocking issues,
    # or confirmed by a person.
    def confident?
      %w[merchant_name purchased_on total].all? do |field|
        next true if reviewed?(field)
        key = ReceiptParser::FIELD_FOR_COLUMN.fetch(field)
        extraction.dig("fields", key, "value").present? && extraction.dig("fields", key, "confidence").to_f >= ReceiptParser::CONFIDENT &&
          (ReceiptParser::BLOCKING_ISSUES & Array(issues)).empty?
      end
    end

    def field_confidence(column)
      return 1.0 if reviewed?(column)
      key = ReceiptParser::FIELD_FOR_COLUMN[column.to_s]
      key ? extraction.dig("fields", key, "confidence").to_f : nil
    end

    def uncertain?(column)
      value = public_send(column)
      value.nil? || (field_confidence(column) || 1) < ReceiptParser::CONFIDENT
    end

    def cash? = payment_method == "cash"

    def refund? = direction == "refund"

    # Minor units (cents) for the shared matcher.
    def total_minor = total && (total * 100).to_i

    # The verification state shown to a person (see the domain doc §4). Derived, never stored, so it
    # cannot drift from the matches it summarizes.
    def verification
      return status if %w[duplicate possible_duplicate dismissed].include?(status)
      confirmed = confirmed_matches
      if confirmed.any?
        entries = confirmed.map(&:finance_transaction)
        book_currency = Profile.find_by(user_id: user_id)&.currency
        return "foreign_currency" if currency && book_currency && currency != book_currency
        return "amount_mismatch" if total.nil? || entries.sum { |entry| entry.amount.abs } != total
        return confirmed.all? { |match| match.decided_by == "user" } ? "verified" : "auto_matched"
      end
      return "needs_review" if suggested_matches.any? || status == "needs_review"
      return "cash" if status == "cash"
      return "entry_in_trash" if entry&.deleted_at
      status
    end

    # Recomputes the stored status after matches or the recorded entry changed underneath (a statement
    # was removed, an entry purged). Duplicates and dismissed receipts keep their status.
    def refresh_status!
      return if %w[duplicate possible_duplicate dismissed].include?(status)
      reload
      next_status = if matches.confirmed.exists? then "matched"
      elsif entry && entry.deleted_at.nil? && !entry.superseded? then (cash? ? "cash" : "pending_bank_match")
      else "needs_review"
      end
      update_columns(status: next_status, updated_at: Time.current) if next_status != status
    end

    def display_name
      merchant_name.presence || filename.presence || I18n.t("billie.receipts.untitled")
    end

    private

    def same_owner_as_references
      [[:entry, entry], [:bank_account, bank_account], [:duplicate_of, duplicate_of]].each do |name, record|
        errors.add(name, :same_owner) if record && record.user_id != user_id
      end
    end

    def category_is_known
      return if category.nil?
      errors.add(:category, :inclusion) unless Category.valid_for?(user_id, category)
    end
  end
end
