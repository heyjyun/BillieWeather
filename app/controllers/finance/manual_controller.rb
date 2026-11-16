module Finance
  # The Manual Mode home (手动记账): the book, quick ways to record each entry type, and every manual
  # bookkeeping tool grouped by task. It shows the same records as the default dashboard.
  class ManualController < BaseController
    include ManualWorkspace

    def show
      @book = Book.default_for(current_user)
      @net_worth = BankAccount.net_worth_for(current_user)
      @account_count = current_user.finance_bank_accounts.where(archived_at: nil).count
      @review_counts = ledger_review_counts
      @recent = current_user.finance_transactions.live.where(entry_origin: %w[manual recurring])
        .includes(:statement, :bank_account, :merchant, :project, :tags).order(booked_on: :desc, id: :desc).limit(5).to_a
      @budget_count = current_user.finance_budgets.count
      @recurring_count = current_user.finance_recurring_rules.where(paused: false).count
    end

    # Book settings (账本设置): the book's name. (One book per person on the web for now.)
    def update_book
      book = Book.default_for(current_user)
      before = audit_values(book, %w[name])
      if book.update(params.require(:book).permit(:name))
        audit!("update", book, before, audit_values(book, %w[name]), summary: book.name)
        redirect_to finance_manual_path, notice: I18n.t("billie.ledger.manual.book.saved")
      else
        redirect_to finance_manual_path, alert: book.errors.full_messages.to_sentence
      end
    end
  end
end
