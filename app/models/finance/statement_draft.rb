module Finance
  class StatementDraft < ActiveRecord::Base
    self.table_name = "finance_statement_drafts"

    MAX_ROWS = 500
    belongs_to :user

    scope :active, -> { where("expires_at > ?", Time.current) }

    validates :filename, presence: true, length: {maximum: 255}
    validates :sha256, format: {with: /\A[0-9a-f]{64}\z/}
    validates :currency, inclusion: {in: Finance::Profile::CURRENCIES}
    validates :expires_at, presence: true
    validate :valid_review_rows
    validate :valid_warnings
    validate :future_expiration, on: :create

    def expired?
      expires_at.nil? || expires_at <= Time.current
    end

    private

    def valid_review_rows
      unless rows.is_a?(Array) && rows.length.between?(1, MAX_ROWS)
        errors.add(:rows, "must contain 1–#{MAX_ROWS} reviewable transactions")
        return
      end
      rows.each_with_index do |row, index|
        unless row.is_a?(Hash) && row["description"].is_a?(String) && row["description"].length.between?(1, 500) &&
            row["booked_on"].is_a?(String) && /\A\d{4}-\d{2}-\d{2}\z/.match?(row["booked_on"]) &&
            row["amount"].is_a?(String) && (row["amount"].blank? || /\A[+-]?\d{1,13}(?:\.\d{1,2})?\z/.match?(row["amount"]))
          errors.add(:rows, "contain invalid details at row #{index + 1}")
          break
        end
        begin
          date = Date.iso8601(row["booked_on"])
          raise ArgumentError unless date.year.between?(1900, 2100)
        rescue ArgumentError
          errors.add(:rows, "contain an invalid date at row #{index + 1}")
          break
        end
      end
    end

    def valid_warnings
      unless warnings.is_a?(Array) && warnings.length <= 1_000 && warnings.all? { |warning| warning.is_a?(String) && warning.length <= 500 }
        errors.add(:warnings, "could not be saved for review")
      end
    end

    def future_expiration
      if expires_at && (expired? || expires_at > 31.minutes.from_now)
        errors.add(:expires_at, "must be within the next 30 minutes")
      end
    end
  end
end
