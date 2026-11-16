module Finance
  # A financial account (账户): a bank account or card found in an imported statement, or one created by
  # hand (cash, wallet, loan, receivable, …). Balance = opening balance + every live entry (derived).
  class BankAccount < ActiveRecord::Base
    self.table_name = "finance_bank_accounts"

    KINDS = %w[cash credit unknown].freeze
    TYPES = Domain::ACCOUNT_TYPES

    belongs_to :user
    has_many :statements, class_name: "Finance::Statement", dependent: :nullify
    has_many :statement_drafts, class_name: "Finance::StatementDraft", dependent: :nullify
    has_many :transactions, class_name: "Finance::Transaction", dependent: :restrict_with_error

    validates :identity_key, format: {with: /\A[0-9a-f]{64}\z/}, uniqueness: {scope: :user_id}, unless: :manual?
    validates :bank_name, presence: true, length: {maximum: 100}, unless: :manual?
    validates :bank_name, length: {maximum: 100}, allow_nil: true
    validates :name, presence: true, length: {maximum: 100}
    validates :last4, format: {with: /\A\d{4}\z/}, unless: :manual?
    validates :last4, format: {with: /\A\d{4}\z/}, allow_blank: true, if: :manual?
    validates :kind, inclusion: {in: KINDS}
    validates :account_type, inclusion: {in: TYPES}
    validates :custom_name, length: {maximum: 60}, format: {with: /\A[^\p{Cc}]*\z/, message: :control_characters}, allow_nil: true
    validates :opening_balance, numericality: {greater_than: -10**13, less_than: 10**13}
    validates :credit_limit, numericality: {greater_than_or_equal_to: 0, less_than: 10**13}, allow_nil: true
    validates :statement_day, :due_day, numericality: {only_integer: true, in: 1..31}, allow_nil: true
    validates :note, length: {maximum: 500}

    before_validation { self.custom_name = custom_name.to_s.squish.presence }
    before_validation :keep_legacy_kind

    scope :active, -> { where(archived_at: nil) }
    scope :ordered, -> { order(:sort_order, :id) }

    def self.resolve(user:, identity:)
      return unless identity && identity[:account_key].present?
      find_or_create_by!(user_id: user.id, identity_key: identity[:account_key]) do |account|
        account.bank_name = identity[:bank_name]
        account.name = identity[:account_name].to_s.sub(/\s*•+\d{4}\z/, "").presence || "Account"
        account.last4 = identity[:account_last4]
        account.kind = identity[:account_kind]
        account.account_type = Domain.account_type_from_legacy(identity[:account_kind], "web")
      end
    end

    # What the person sees everywhere. A name they typed always wins over the one read from the statement.
    def display_name
      custom_name.presence || auto_name
    end

    # The name read from the statement: bank, account type and last four digits.
    def auto_name
      return name if manual?
      "#{bank_name} · #{localized_account_type} · ••#{last4}"
    end

    def localized_account_type
      key = {"Checking" => "checking", "Savings" => "savings", "Credit account" => "credit_account",
             "Cash account" => "cash_account", "Account" => "account"}[name]
      key ? I18n.t("billie.helpers.labels.#{key}") : name
    end

    def liability?
      Domain.liability?(account_type)
    end

    def archived?
      archived_at.present?
    end

    # Opening balance plus every live entry up to `as_of` (inclusive). Excluded rows still move money.
    def balance(as_of: nil)
      scope = transactions.live
      scope = scope.where("booked_on <= ?", as_of) if as_of
      opening_balance + scope.sum(:amount)
    end

    def self.balances_for(user, as_of: nil)
      sums = Transaction.live.where(user_id: user.id).where.not(bank_account_id: nil)
      sums = sums.where("booked_on <= ?", as_of) if as_of
      totals = sums.group(:bank_account_id).sum(:amount)
      where(user_id: user.id).to_h { |account| [account.id, account.opening_balance + (totals[account.id] || 0)] }
    end

    # Assets, liabilities (positive amount owed) and net worth over accounts included in net worth.
    def self.net_worth_for(user, as_of: nil)
      balances = balances_for(user, as_of: as_of)
      assets = BigDecimal(0)
      liabilities = BigDecimal(0)
      where(user_id: user.id, include_in_net_worth: true).find_each do |account|
        balance = balances[account.id] || 0
        if account.liability? then liabilities -= balance else assets += balance end
      end
      {assets: assets, liabilities: liabilities, net_worth: assets - liabilities}
    end

    private

    # The older `kind` column (cash|credit|unknown) is still read by balance summaries.
    def keep_legacy_kind
      return unless will_save_change_to_account_type? || new_record?
      self.kind = if Domain.liability?(account_type) then "credit"
      elsif %w[checking savings].include?(account_type) then "cash"
      else (manual? ? "unknown" : kind.presence || "unknown")
      end
    end
  end
end
