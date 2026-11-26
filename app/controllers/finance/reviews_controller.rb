module Finance
  # Review lists for decisions only a person can make:
  # - income that is probably not income (a refund or a card repayment counted as income before kinds
  #   existed, P0-2); one click reclassifies, nothing changes on its own;
  # - possible duplicates found while importing (P0-3): keep both, or move the copy to the trash.
  class ReviewsController < BaseController

    def income
      @suspects = suspect_income.first(300)
    end

    def reclassify
      entry = current_user.finance_transactions.live.find(params[:id])
      kind = params[:kind].presence_in(%w[refund card_payment transfer income])
      return redirect_to finance_review_income_path, alert: ledger_errors("kind_invalid") unless kind
      attrs = {kind: kind}
      attrs[:category] = Transaction::UNCATEGORIZED if kind == "refund" && Transaction.income_category?(current_user.id, entry.category)
      ledger.update(entry, attrs)
      redirect_to finance_review_income_path, notice: I18n.t("billie.ledger.review.reclassified", kind: I18n.t("billie.ledger.kinds.#{kind}"))
    end

    def duplicates
      @links = current_user.finance_transaction_links.suggested.where(link_type: "duplicate_of")
        .includes(:from_transaction, :to_transaction).order(id: :desc).limit(300).to_a
        .select { |link| link.from_transaction&.deleted_at.nil? && link.to_transaction }
    end

    def resolve_duplicate
      link = current_user.finance_transaction_links.where(link_type: "duplicate_of").find(params[:id])
      if params[:decision] == "duplicate"
        ledger.delete(link.from_transaction)
        link.update!(status: "confirmed", decided_by: "user")
        notice = I18n.t("billie.ledger.review.duplicate_removed")
      else
        link.update!(status: "rejected", decided_by: "user")
        notice = I18n.t("billie.ledger.review.duplicate_kept")
      end
      audit!("update", link, {"status" => "suggested"}, {"status" => link.status}, summary: link.from_transaction.description)
      redirect_to finance_review_duplicates_path, notice: notice
    end

    private

    def suspect_income
      current_user.finance_transactions.live.where(kind: "income").where.not("jsonb_exists(user_locked_fields, 'kind')")
        .includes(:bank_account, statement: :bank_account).order(booked_on: :desc).to_a.filter_map do |entry|
          suggested = Domain.suspect_income(kind: entry.kind, amount: entry.amount, account_type: entry.account_type, description: entry.original_description)
          [entry, suggested] if suggested
        end
    end
  end
end
