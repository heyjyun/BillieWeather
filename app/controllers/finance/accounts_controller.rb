module Finance
  # Accounts (账户): every account with its balance (opening balance + live entries), grouped by type,
  # with assets, liabilities and net worth. Accounts can be created by hand (cash, wallets, loans, …),
  # edited, reordered, archived (history kept), deleted when nothing uses them, and set to the balance
  # the person sees with an adjustment entry.
  class AccountsController < BaseController

    FIELDS = %w[custom_name name account_type opening_balance opening_balance_on credit_limit statement_day due_day include_in_net_worth note archived_at sort_order].freeze

    before_action :load_account, except: [:index, :new, :create]

    def index
      accounts = current_user.finance_bank_accounts.ordered.to_a
      @balances = BankAccount.balances_for(current_user)
      @active = accounts.reject(&:archived?)
      @archived = accounts.select(&:archived?)
      @groups = @active.group_by(&:account_type).sort_by { |type, _| BankAccount::TYPES.index(type) }
      @net_worth = BankAccount.net_worth_for(current_user)
      @entry_counts = current_user.finance_transactions.live.group(:bank_account_id).count
    end

    def new
      @account = current_user.finance_bank_accounts.new(manual: true, account_type: params[:type].presence_in(BankAccount::TYPES) || "cash",
        currency: @profile.currency, opening_balance_on: finance_today)
    end

    def create
      @account = current_user.finance_bank_accounts.new(account_params.merge(manual: true, currency: @profile.currency,
        sort_order: (current_user.finance_bank_accounts.maximum(:sort_order) || 0) + 1))
      @account.name = @account.custom_name.presence || I18n.t("billie.ledger.account_types.#{@account.account_type}", default: "Account")
      if @account.save
        audit!("create", @account, {}, audit_values(@account, FIELDS))
        redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.created", name: @account.display_name)
      else
        render :new, status: :unprocessable_entity
      end
    end

    def edit
      @balance = @account.balance
    end

    def update
      before = audit_values(@account, FIELDS)
      attributes = account_params
      # Imported accounts keep the type their statements were read with unless the person changes it.
      if @account.update(attributes)
        audit!("update", @account, before, audit_values(@account, FIELDS))
        redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.updated", name: @account.display_name)
      else
        @balance = @account.balance
        render :edit, status: :unprocessable_entity
      end
    end

    def archive
      before = audit_values(@account, FIELDS)
      @account.update!(archived_at: Time.current)
      audit!("archive", @account, before, audit_values(@account, FIELDS))
      redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.archived", name: @account.display_name)
    end

    def unarchive
      before = audit_values(@account, FIELDS)
      @account.update!(archived_at: nil)
      audit!("unarchive", @account, before, audit_values(@account, FIELDS))
      redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.unarchived", name: @account.display_name)
    end

    # Moves an account one place up or down among the accounts of its type.
    def move
      siblings = current_user.finance_bank_accounts.ordered.where(account_type: @account.account_type).to_a
      index = siblings.index(@account)
      other = siblings[(params[:direction] == "up") ? index - 1 : index + 1] if index
      if other && (params[:direction] != "up" || index.positive?)
        BankAccount.transaction do
          siblings.each_with_index { |account, position| account.update_columns(sort_order: position) }
          a, b = @account.reload.sort_order, other.reload.sort_order
          @account.update_columns(sort_order: b)
          other.update_columns(sort_order: a)
        end
      end
      redirect_to finance_accounts_path
    end

    # Records a balance adjustment (余额): the difference between the computed and the real balance.
    def adjust
      on = params[:on].present? ? Date.iso8601(params[:on]) : finance_today
      entry = ledger.adjust_balance(@account, params[:balance], on: on, note: params[:note])
      redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.adjusted", name: @account.display_name, amount: helpers.finance_money(entry.amount, @profile.currency))
    rescue Ledger::Invalid, Date::Error => error
      redirect_to edit_finance_account_path(@account), alert: ledger_errors(error.respond_to?(:codes) ? error.codes : "date_invalid")
    end

    def destroy
      if current_user.finance_transactions.where(bank_account_id: @account.id).exists? || @account.statements.exists?
        return redirect_to finance_accounts_path, alert: I18n.t("billie.ledger.accounts.in_use", name: @account.display_name)
      end
      # Receipts are evidence a person keeps; deleting the account must never delete or orphan them.
      if current_user.finance_receipts.where(bank_account_id: @account.id).exists?
        return redirect_to finance_accounts_path, alert: I18n.t("billie.ledger.accounts.in_use_receipts", name: @account.display_name)
      end
      before = audit_values(@account, FIELDS)
      ActiveRecord::Base.transaction do
        @account.destroy!
        audit!("delete", @account, before, {})
      end
      redirect_to finance_accounts_path, notice: I18n.t("billie.ledger.accounts.deleted", name: @account.display_name)
    rescue ActiveRecord::InvalidForeignKey
      # Something else started referencing the account between the checks and the delete
      # (or a table added later): refuse instead of failing with a 500. Nothing was deleted.
      redirect_to finance_accounts_path, alert: I18n.t("billie.ledger.accounts.in_use", name: @account.display_name)
    end

    private

    def load_account
      @account = current_user.finance_bank_accounts.find(params[:id])
    end

    def account_params
      permitted = params.require(:finance_bank_account).permit(:custom_name, :account_type, :opening_balance, :opening_balance_on, :credit_limit,
        :statement_day, :due_day, :include_in_net_worth, :note)
      permitted[:opening_balance] = permitted[:opening_balance].to_s.delete(",").presence || "0" if permitted.key?(:opening_balance)
      permitted[:credit_limit] = permitted[:credit_limit].to_s.delete(",").presence if permitted.key?(:credit_limit)
      permitted[:statement_day] = permitted[:statement_day].presence if permitted.key?(:statement_day)
      permitted[:due_day] = permitted[:due_day].presence if permitted.key?(:due_day)
      permitted[:opening_balance_on] = permitted[:opening_balance_on].presence if permitted.key?(:opening_balance_on)
      permitted
    end
  end
end
