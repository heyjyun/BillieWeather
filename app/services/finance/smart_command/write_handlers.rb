module Finance
  module SmartCommand
    # Data-changing commands, through the website's own models and their validations. `prepare`
    # never writes; with `lock: true` (during execution, inside the executor's transaction) it locks
    # the rows it would change, so the preview comparison and the change see the same data.
    #
    # Undo restores exactly the previous values, once, and only when nothing changed since: if any
    # affected row or category was edited afterwards, it refuses (undo_conflict) and changes nothing.
    # Unlike the transaction edit form, a command does not remember merchant rules, so the preview
    # lists every change it makes and undo can restore all of them.
    class WriteHandlers
      ACTIONS = %w[transactions.categorize transactions.exclude transactions.include categories.create categories.rename].freeze
      # At most this many transactions change in one command (same limit as the universal client).
      MAX_BULK = 500

      def initialize(user:, category_label:)
        @user = user
        @category_label = category_label
      end

      def prepare(action_id, args, lock: false)
        case action_id
        when "transactions.categorize" then prepare_rows(args, lock, field: "category", value: args["category"], category_filter: false)
        when "transactions.exclude" then prepare_rows(args, lock, field: "excluded", value: true)
        when "transactions.include" then prepare_rows(args, lock, field: "excluded", value: false)
        when "categories.create" then prepare_create(args)
        when "categories.rename" then prepare_rename(args, lock)
        end
      end

      # Runs inside the executor's transaction. Returns {summary:, undo:}.
      def execute(action_id, prepared, args)
        case action_id
        when "transactions.categorize", "transactions.exclude", "transactions.include" then execute_rows(action_id, prepared)
        when "categories.create" then execute_create(prepared)
        when "categories.rename" then execute_rename(prepared)
        end
      end

      # Runs inside the executor's transaction; raises Rejection("undo_conflict") to change nothing.
      def undo(action_id, payload)
        case action_id
        when "transactions.categorize", "transactions.exclude", "transactions.include" then undo_rows(payload)
        when "categories.create" then undo_create(payload)
        when "categories.rename" then undo_rename(payload)
        end
        message("undone", "Undone.")
      end

      private

      def message(code, text, vars = {})
        {code: code, message: text, vars: vars}
      end

      def transactions
        Transaction.where(user_id: @user.id)
      end

      def touch_profile
        # Insights compare their age with the finance data; same as editing on the Transactions page.
        Profile.where(user_id: @user.id).touch_all
      end

      def conflict!
        raise Rejection.new("undo_conflict", "This changed again since, so nothing was undone.")
      end

      # ---------- transactions: category, excluded ----------

      def prepare_rows(args, lock, field:, value:, category_filter: true)
        scope = TransactionFilter.apply(transactions, args, category: category_filter).where.not(field => value).order(:id)
        scope = scope.lock if lock
        rows = scope.limit(MAX_BULK + 1).to_a
        return {operations: [], summary: message("too_many", "More than #{MAX_BULK} transactions match. Narrow it down.", max: MAX_BULK)} if rows.size > MAX_BULK
        return {operations: [], summary: message("no_match", "No transactions match.")} if rows.empty?
        operations = rows.map do |row|
          {op: "update", target: {kind: "transaction", id: row.id.to_s, label: "#{row.booked_on.iso8601} · #{row.description}"},
           before: {field => row[field]}, after: {field => value}}
        end
        {operations: operations, payload: {rows: rows, field: field, value: value}}
      end

      def execute_rows(action_id, prepared)
        payload = prepared[:payload]
        field = payload[:field]
        restore = payload[:rows].map { |row| {"id" => row.id, "before" => row[field], "after" => payload[:value]} }
        payload[:rows].each { |row| row.update!(field => payload[:value]) }
        touch_profile
        count = restore.size
        summary = case action_id
        when "transactions.categorize" then message("categorized", "{count} transaction(s) moved to {category}.", count: count, category: payload[:value])
        when "transactions.exclude" then message("excluded", "{count} transaction(s) excluded from totals.", count: count)
        else message("included", "{count} transaction(s) counted again.", count: count)
        end
        {summary: summary, undo: {"field" => field, "rows" => restore}}
      end

      def undo_rows(payload)
        field = payload.fetch("field")
        raise ArgumentError, "unexpected field" unless %w[category excluded].include?(field)
        saved = payload.fetch("rows").index_by { |row| row.fetch("id") }
        rows = transactions.where(id: saved.keys).order(:id).lock.to_a
        conflict! unless rows.size == saved.size
        conflict! if rows.any? { |row| row[field] != saved.fetch(row.id)["after"] }
        # A category deleted since cannot be restored.
        conflict! if field == "category" && saved.values.map { |row| row["before"] }.uniq.any? { |name| !CustomCategory.valid_for?(@user, name) }
        rows.each { |row| row.update!(field => saved.fetch(row.id)["before"]) }
        touch_profile
      end

      # ---------- categories ----------

      def category_problem(record)
        if record.errors.of_kind?(:name, :reserved)
          message("category_reserved", "“{name}” is a built-in category.", name: record.name)
        elsif record.errors.of_kind?(:name, :taken)
          message("category_exists", "{name} already exists.", name: record.name)
        elsif record.errors.of_kind?(:base, :too_many)
          message("category_limit", "You can have at most {max} categories of your own.", max: CustomCategory::MAX_PER_USER)
        else
          message("invalid", "That value can't be used here.")
        end
      end

      def prepare_create(args)
        record = @user.finance_custom_categories.new(name: args["name"])
        return {operations: [], summary: category_problem(record)} unless record.valid?
        {operations: [{op: "create", target: {kind: "category", id: record.name, label: record.name}}], payload: {name: record.name}}
      end

      def execute_create(prepared)
        record = @user.finance_custom_categories.create!(name: prepared[:payload][:name])
        touch_profile
        {summary: message("category_created", "Created category {name}.", name: record.name), undo: {"id" => record.id, "name" => record.name}}
      end

      # Removes the category only while nothing uses it, so later work is never lost.
      def undo_create(payload)
        record = @user.finance_custom_categories.lock.find_by(id: payload.fetch("id"))
        conflict! unless record && record.name == payload.fetch("name")
        conflict! if transactions.where(category: record.name).exists? || MerchantRule.where(user_id: @user.id, category: record.name).exists?
        record.destroy!
        touch_profile
      end

      def prepare_rename(args, lock)
        scope = @user.finance_custom_categories
        scope = scope.lock if lock
        record = scope.find_by(name: args["from"])
        return {operations: [], summary: message("no_effect", "Nothing would change.")} unless record
        from = record.name
        # Validate the new name with the model's own rules, then put the record back as it is
        # stored: CustomCategory#rename! reads the old name from it.
        record.name = args["to"]
        to = record.name
        problem = (to == from) ? message("same_name", "That is already its name.") : (category_problem(record) unless record.valid?)
        record.restore_attributes([:name])
        return {operations: [], summary: problem} if problem
        used = transactions.where(category: from).count
        {operations: [{op: "rename", target: {kind: "category", id: from, label: from}, before: from, after: to}],
         payload: {record: record, from: from, to: to}, summary: message("rename_preview", "{count} transaction(s) use it.", count: used)}
      end

      def execute_rename(prepared)
        record, from, to = prepared[:payload].values_at(:record, :from, :to)
        raise Rejection.new("no_effect", "Nothing would change.", summary_code: category_problem(record)[:code]) unless record.rename!(to)
        {summary: message("category_renamed", "Renamed {from} to {to}.", from: from, to: record.name), undo: {"id" => record.id, "from" => from, "to" => record.name}}
      end

      # Renames back only if it still has the new name and the old one is free again.
      def undo_rename(payload)
        record = @user.finance_custom_categories.lock.find_by(id: payload.fetch("id"))
        conflict! unless record && record.name == payload.fetch("to")
        conflict! unless record.rename!(payload.fetch("from"))
      end
    end
  end
end
