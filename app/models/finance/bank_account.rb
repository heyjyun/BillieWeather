module Finance
  class BankAccount < ActiveRecord::Base
    self.table_name = "finance_bank_accounts"

    KINDS = %w[cash credit unknown].freeze
    belongs_to :user
    has_many :statements, class_name: "Finance::Statement", dependent: :nullify
    has_many :statement_drafts, class_name: "Finance::StatementDraft", dependent: :nullify

    validates :identity_key, format: {with: /\A[0-9a-f]{64}\z/}, uniqueness: {scope: :user_id}
    validates :bank_name, :name, presence: true, length: {maximum: 100}
    validates :last4, format: {with: /\A\d{4}\z/}
    validates :kind, inclusion: {in: KINDS}
    validates :custom_name, length: {maximum: 60}, format: {with: /\A[^\p{Cc}]*\z/, message: "can't contain control characters"}, allow_nil: true

    before_validation { self.custom_name = custom_name.to_s.squish.presence }

    def self.resolve(user:, identity:)
      return unless identity && identity[:account_key].present?
      find_or_create_by!(user_id: user.id, identity_key: identity[:account_key]) do |account|
        account.bank_name = identity[:bank_name]
        account.name = identity[:account_name].to_s.sub(/\s*•+\d{4}\z/, "").presence || "Account"
        account.last4 = identity[:account_last4]
        account.kind = identity[:account_kind]
      end
    end

    # What the person sees everywhere. A name they typed always wins over the one read from the statement.
    def display_name
      custom_name.presence || auto_name
    end

    # The name read from the statement: bank, account type and last four digits.
    def auto_name
      "#{bank_name} · #{name} · ••#{last4}"
    end
  end
end
