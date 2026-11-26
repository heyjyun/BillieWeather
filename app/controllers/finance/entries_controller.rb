module Finance
  # Manual entries (记一笔): expense, income, transfer, refund and balance adjustment, created and edited
  # by hand with the same model imports use. Deleting moves an entry to the trash (回收站), from where
  # it can be restored or, for manual entries, removed for good.
  class EntriesController < BaseController

    PERMITTED = %i[kind amount booked_on occurred_at_time account_id to_account_id category merchant_id merchant_name project_id
      tag_names note description refund_of_id excluded tax_review].freeze

    before_action :load_form_data, only: [:new, :preview_quick, :create, :edit, :update]

    def new
      source = params[:copy_from].present? ? current_user.finance_transactions.find(params[:copy_from]) : nil
      @form = source ? copy_form(source) : {kind: params[:kind].presence_in(Ledger::MANUAL_KINDS) || "expense", booked_on: finance_today.iso8601,
        account_id: params[:account_id], refund_of_id: params[:refund_of_id]}
      if @form[:refund_of_id].present?
        original = current_user.finance_transactions.live.find(@form[:refund_of_id])
        @form = @form.merge(kind: "refund", account_id: original.bank_account_id, category: original.category)
      end
    end

    def preview_quick
      @form = QuickEntry.parse(params[:quick_entry])
      return redirect_to finance_add_sync_path, status: :see_other, alert: t("billie.quick_entry.invalid") unless @form

      @quick_entry_draft_id = SecureRandom.uuid
      @form[:booked_on] = finance_today.iso8601
      render :new
    end

    def create
      @form = entry_params
      entry = ledger.create(@form)
      redirect_to after_save_path, notice: I18n.t("billie.ledger.entries.created", kind: I18n.t("billie.ledger.kinds.#{entry.kind}"))
    rescue Ledger::Invalid => error
      flash.now[:alert] = ledger_errors(error.codes)
      render :new, status: :unprocessable_entity
    end

    def edit
      @entry = current_user.finance_transactions.live.find(params[:id])
      @form = form_for_entry(@entry)
    end

    def update
      @entry = current_user.finance_transactions.live.find(params[:id])
      @form = entry_params
      ledger.update(@entry, @entry.manual? ? @form : @form.slice(*Ledger::DISPLAY_FIELDS.map(&:to_sym), :merchant_name, :tag_names))
      redirect_to finance_transactions_path, notice: I18n.t("billie.backend.transaction_updated")
    rescue Ledger::Invalid => error
      flash.now[:alert] = ledger_errors(error.codes)
      @form = form_for_entry(@entry.reload).merge(@form)
      render :edit, status: :unprocessable_entity
    end

    def destroy
      entry = current_user.finance_transactions.live.find(params[:id])
      ledger.delete(entry)
      redirect_back fallback_location: finance_transactions_path, notice: I18n.t("billie.ledger.entries.deleted")
    end

    def trash
      @entries = current_user.finance_transactions.trashed.includes(:bank_account, :statement).order(deleted_at: :desc).limit(500)
    end

    def restore
      entry = current_user.finance_transactions.trashed.find(params[:id])
      ledger.restore(entry)
      redirect_to finance_trash_path, notice: I18n.t("billie.ledger.entries.restored")
    end

    def purge
      entry = current_user.finance_transactions.trashed.find(params[:id])
      ledger.purge(entry)
      redirect_to finance_trash_path, notice: I18n.t("billie.ledger.entries.purged")
    rescue Ledger::Invalid => error
      redirect_to finance_trash_path, alert: ledger_errors(error.codes)
    end

    private

    def entry_params
      params.require(:entry).permit(*PERMITTED).to_h.symbolize_keys
    end

    def after_save_path
      params[:add_another] ? new_finance_entry_path(kind: @form[:kind], account_id: @form[:account_id]) : finance_transactions_path
    end

    def load_form_data
      @accounts = current_user.finance_bank_accounts.active.ordered.to_a
      @tree = CategoryTree.new(current_user)
      @merchants = current_user.finance_merchants.active.ordered.to_a
      @projects = current_user.finance_projects.active.ordered.to_a
      @refundable = current_user.finance_transactions.live.where(kind: "expense").order(booked_on: :desc, id: :desc).limit(200).to_a
    end

    def form_for_entry(entry)
      partner_account = nil
      if %w[transfer card_payment].include?(entry.kind)
        link = TransactionLink.where(user_id: current_user.id, link_type: %w[transfer card_payment]).where("from_transaction_id = :id OR to_transaction_id = :id", id: entry.id).first
        other = link && current_user.finance_transactions.find_by(id: (link.from_transaction_id == entry.id) ? link.to_transaction_id : link.from_transaction_id)
        from, to = entry.amount.negative? ? [entry, other] : [other, entry]
        partner_account = to&.bank_account_id
        account_id = from&.bank_account_id
      end
      {kind: entry.kind, amount: (entry.kind == "adjustment") ? entry.amount.to_s("F") : entry.amount.abs.to_s("F"), booked_on: entry.booked_on.iso8601,
       occurred_at_time: entry.occurred_at_time, account_id: account_id || entry.bank_account_id, to_account_id: partner_account,
       category: entry.category, merchant_id: entry.merchant_id, project_id: entry.project_id, tag_names: entry.tags.map(&:name).join(", "),
       note: entry.note, description: entry.description, excluded: entry.excluded, tax_review: entry.tax_review}
    end

    def copy_form(source)
      form = form_for_entry(source).merge(booked_on: finance_today.iso8601)
      form[:kind] = "transfer" if form[:kind] == "card_payment"
      form[:kind] = "expense" unless Ledger::MANUAL_KINDS.include?(form[:kind])
      form
    end
  end
end
