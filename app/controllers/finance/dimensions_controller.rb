module Finance
  # Merchants (商家), projects (项目) and tags: create, rename, order, archive (hidden from pickers,
  # history kept), merge into another, delete (entries lose the reference). Every change is audited.
  class DimensionsController < BaseController
    include ManualWorkspace

    MODELS = {"merchants" => Merchant, "projects" => Project, "tags" => Tag}.freeze

    before_action :load_model
    before_action :load_record, only: [:update, :destroy, :merge]

    def index
      @records = @model.where(user_id: current_user.id).ordered.to_a
      @report = LedgerReport.new(user: current_user).by(@dimension.singularize)
      @counts = usage_counts
    end

    def create
      attrs = params.fetch(:dimension, {}).permit(:name, :note)
      record = @model.new(user: current_user, name: attrs[:name], note: attrs[:note],
        sort_order: (@model.where(user_id: current_user.id).maximum(:sort_order) || 0) + 1)
      if record.save
        audit!("create", record, {}, {"name" => record.name})
        redirect_to finance_dimension_index_path(@dimension), notice: I18n.t("billie.ledger.lists.created", name: record.name)
      else
        redirect_to finance_dimension_index_path(@dimension), alert: record.errors.full_messages.to_sentence
      end
    end

    def update
      before = audit_values(@record, %w[name note archived_at sort_order])
      attrs = params.fetch(:dimension, {}).permit(:name, :note, :sort_order).to_h
      attrs[:archived_at] = Time.current if params[:archive] == "1"
      attrs[:archived_at] = nil if params[:archive] == "0"
      if @record.update(attrs)
        audit!(attrs.key?(:archived_at) ? (attrs[:archived_at] ? "archive" : "unarchive") : "update", @record, before, audit_values(@record, %w[name note archived_at sort_order]))
        redirect_to finance_dimension_index_path(@dimension), notice: I18n.t("billie.ledger.lists.updated", name: @record.name)
      else
        redirect_to finance_dimension_index_path(@dimension), alert: @record.errors.full_messages.to_sentence
      end
    end

    def merge
      target = @model.where(user_id: current_user.id).find(params[:into])
      return redirect_to finance_dimension_index_path(@dimension), alert: ledger_errors("merge_same") if target == @record
      moved = 0
      @model.transaction do
        if @model == Tag
          TransactionTag.where(tag_id: @record.id).find_each do |link|
            moved += 1
            TransactionTag.find_or_create_by!(transaction_id: link.transaction_id, tag_id: target.id)
          end
          TransactionTag.where(tag_id: @record.id).delete_all
        else
          column = (@model == Merchant) ? :merchant_id : :project_id
          moved = Transaction.where(user_id: current_user.id, column => @record.id).update_all(column => target.id, updated_at: Time.current)
          Budget.where(user_id: current_user.id, project_id: @record.id).update_all(project_id: target.id) if @model == Project
        end
        audit!("merge", @record, {"name" => @record.name}, {"into" => target.name, "entries" => moved})
        @record.destroy!
      end
      redirect_to finance_dimension_index_path(@dimension), notice: I18n.t("billie.ledger.lists.merged", name: @record.name, into: target.name, count: moved)
    end

    def destroy
      count = usage_counts[@record.id].to_i
      @record.destroy!
      audit!("delete", @record, {"name" => @record.name, "entries" => count}, {})
      redirect_to finance_dimension_index_path(@dimension), notice: I18n.t("billie.ledger.lists.deleted", name: @record.name, count: count)
    end

    private

    def load_model
      @dimension = params[:list]
      @model = MODELS.fetch(@dimension)
    end

    def load_record
      @record = @model.where(user_id: current_user.id).find(params[:id])
    end

    def usage_counts
      if @model == Tag
        TransactionTag.joins(:finance_transaction).where(finance_transactions: {user_id: current_user.id, deleted_at: nil, superseded_by_id: nil}).group(:tag_id).count
      else
        Transaction.live.where(user_id: current_user.id).group((@model == Merchant) ? :merchant_id : :project_id).count
      end
    end
  end
end
