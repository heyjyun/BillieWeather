module Finance
  # Capture (scan, upload, drag and drop, typed details), review and matching decisions for receipts.
  # Every query is scoped to current_user; decisions go through Finance::ReceiptReconciler (locked, audited).
  class ReceiptsController < BaseController
    MAX_FILES = 10
    # The only reconciler methods a match decision may call (also the route's constraint, config/routes.rb).
    DECISIONS = {"confirm" => :confirm, "reject" => :reject, "undo" => :undo, "reconsider" => :reconsider}.freeze
    before_action :find_receipt, except: [:index, :create, :decide]

    def index
      @receipts = current_user.finance_receipts.visible.newest_first.includes(:entry, :matches).limit(60).to_a
      @statements = current_user.finance_statements.order(created_at: :desc).limit(5).to_a
      @tokens = current_user.finance_capture_tokens.order(created_at: :desc).to_a
      @local_ocr = LocalOcr.available?
    end

    def create
      receipt = params[:receipt]
      unless receipt.is_a?(ActionController::Parameters)
        return redirect_to finance_receipts_path, alert: t("billie.backend.unreadable_files")
      end
      files = Array(receipt[:files]).reject(&:blank?)
      return redirect_to finance_receipts_path, alert: t("billie.receipts.flash.too_many", count: MAX_FILES) if files.length > MAX_FILES
      unless files.all? { |file| file.is_a?(ActionDispatch::Http::UploadedFile) }
        return redirect_to finance_receipts_path, alert: t("billie.backend.unreadable_files")
      end
      source = receipt[:source].presence_in(%w[camera upload]) || "upload"
      results = if files.any?
        files.map { |file| ingest(file: file, source: source) }
      else
        [ingest(source: "manual", fields: receipt.permit(*Receipt::EDITABLE).to_h)]
      end
      added = results.compact
      failed = results.length - added.length
      return redirect_to finance_receipts_path, alert: @error if added.empty?
      if added.one? && failed.zero?
        result = added.first
        notice = result.created ? t("billie.receipts.flash.added") : t("billie.receipts.flash.already_added")
        return redirect_to finance_receipt_path(result.receipt), notice: notice
      end
      message = t("billie.receipts.flash.batch", added: added.count(&:created), existing: added.count { |result| !result.created }, failed: failed)
      redirect_to finance_receipts_path, (failed.zero? ? :notice : :alert) => [message, @error].compact.join(" ")
    end

    def show
      @matches = @receipt.matches.includes(finance_transaction: [:bank_account, :statement]).order(:status, score: :desc).to_a
      @category_tree = CategoryTree.new(current_user)
      @accounts = current_user.finance_bank_accounts.where(archived_at: nil).order(:sort_order, :id).to_a
      @candidates = link_candidates
      @duplicate_of = @receipt.duplicate_of
    end

    def update
      reconciler.update_fields(@receipt, params.require(:receipt).permit(*Receipt::EDITABLE).to_h)
      redirect_to finance_receipt_path(@receipt), notice: t("billie.receipts.flash.saved")
    rescue Ledger::Invalid => error
      redirect_to finance_receipt_path(@receipt), alert: ledger_errors(error.codes)
    end

    # The original file, from private storage, only for its owner. Images and PDFs only; never cached.
    def file
      return head :not_found unless @receipt.file.attached?
      blob = @receipt.file.blob
      return head :not_found unless Receipt::CONTENT_TYPES.include?(blob.content_type)
      response.headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
      response.headers["X-Content-Type-Options"] = "nosniff"
      send_data blob.download, type: blob.content_type, disposition: (params[:download] ? "attachment" : "inline"), filename: blob.filename.to_s
    end

    def record = act(:record!, :recorded)

    def dismiss = act(:dismiss, :dismissed, back: finance_receipts_path)

    def reopen = act(:reopen, :reopened)

    def not_duplicate = act(:not_duplicate, :not_duplicate)

    def mark_duplicate = act(:mark_duplicate, :marked_duplicate)

    def link
      reconciler.link_manually(@receipt, params.require(:transaction_id))
      redirect_to finance_receipt_path(@receipt), notice: t("billie.receipts.flash.linked")
    rescue Ledger::Invalid => error
      redirect_to finance_receipt_path(@receipt), alert: ledger_errors(error.codes)
    end

    # Confirm match / Keep separate / Undo / Reconsider.
    def decide
      decision = params[:decision].to_s
      action = DECISIONS[decision]
      return head(:not_found) unless action
      match = current_user.finance_receipt_matches.find(params[:match_id])
      reconciler.public_send(action, match)
      back = (params[:from] == "reconciliation") ? finance_reconciliation_path : finance_receipt_path(match.receipt_id)
      redirect_to back, notice: t("billie.receipts.flash.decision.#{decision}")
    rescue Ledger::Invalid => error
      redirect_to finance_receipt_path(match.receipt_id), alert: ledger_errors(error.codes)
    end

    private

    def find_receipt
      @receipt = current_user.finance_receipts.find(params[:id])
    end

    def reconciler = @reconciler ||= ReceiptReconciler.new(current_user)

    def ingest(**options)
      ReceiptIngestion.call(user: current_user, **options)
    rescue Ledger::Invalid => error
      @error = ledger_errors(error.codes)
      nil
    end

    def act(method, notice, back: nil)
      reconciler.public_send(method, @receipt)
      redirect_to back || finance_receipt_path(@receipt), notice: t("billie.receipts.flash.#{notice}")
    rescue Ledger::Invalid => error
      redirect_to finance_receipt_path(@receipt), alert: ledger_errors(error.codes)
    end

    # Entries a person may link by hand: live, not from a receipt, near the purchase date, without a receipt.
    def link_candidates
      return [] if @receipt.purchased_on.nil? || @receipt.matches.any? { |match| match.status == "confirmed" }
      taken = current_user.finance_receipt_matches.confirmed.select(:transaction_id)
      current_user.finance_transactions.live.where(kind: %w[expense refund income], booked_on: (@receipt.purchased_on - 10)..(@receipt.purchased_on + 10))
        .where.not(entry_origin: "receipt").where.not(id: taken).order(Arel.sql("ABS(booked_on - DATE '#{@receipt.purchased_on.iso8601}')"), :id).limit(30).to_a
    end
  end
end
