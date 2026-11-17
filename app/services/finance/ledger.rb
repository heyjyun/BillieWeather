module Finance
  # Manual bookkeeping (finance-domain-spec §2): every create, edit, delete, restore and batch change of
  # an entry goes through here, inside the person's row lock and one database transaction, and writes
  # an audit event with the values before and after (so it can be traced and undone).
  #
  # Kinds: expense, income, refund (linked to the original expense, partial allowed), transfer (two legs
  # plus a link; card_payment when the destination is a credit card or loan), adjustment (moves an
  # account to the balance the person sees). Amounts are typed as positive numbers and stored signed
  # from the account's point of view.
  class Ledger
    class Invalid < StandardError
      attr_reader :codes

      def initialize(codes)
        @codes = Array(codes)
        super(@codes.join(", "))
      end
    end

    MANUAL_KINDS = %w[expense income transfer refund adjustment].freeze
    # Fields of an imported entry a person may change (the amount, date and account are the bank's).
    DISPLAY_FIELDS = %w[description category kind merchant_id project_id note excluded tax_review occurred_at_time].freeze
    AUDITED = %w[booked_on occurred_at_time amount kind category description note bank_account_id merchant_id project_id excluded tax_review deleted_at category_source user_locked_fields].freeze

    attr_reader :user

    def initialize(user)
      @user = user
    end

    def tree
      @tree ||= CategoryTree.new(@user)
    end

    # Creates one manual entry (two legs for a transfer). Returns the entry (the outflow leg for transfers).
    def create(params = {}, actor: "user", batch_id: nil, origin: "manual", recurring: nil, **attributes)
      p = normalize(params.to_h.merge(attributes))
      locked do
        account = find_account(p[:account_id])
        case p[:kind]
        when "transfer"
          create_transfer(p, account, find_account(p[:to_account_id]), actor, batch_id, origin, recurring)
        when "adjustment"
          create_adjustment(p, account, actor, batch_id)
        else
          create_single(p, account, actor, batch_id, origin, recurring)
        end
      end
    end

    # Edits an entry. Manual entries: every field. Imported entries: display fields only.
    def update(entry, params = {}, actor: "user", **attributes)
      p = normalize(params.to_h.merge(attributes), partial: true)
      locked do
        entry = own(entry.id).lock!
        before = snapshot(entry)
        if entry.manual?
          leg = transfer_partner(entry)
          if leg
            update_transfer(entry, leg, p)
          else
            apply_manual(entry, p)
          end
        else
          apply_display(entry, p)
        end
        # Category validation may normalize kind; check relations against the final kind.
        entry.validate!
        entry.outgoing_links.where(link_type: "refund_of").destroy_all if entry.kind != "refund"
        validate_refund_integrity!(entry)
        entry.lock_fields!(*locked_fields_for(p, entry))
        entry.save!
        audit("update", entry, before, snapshot(entry), actor: actor)
        entry
      end
    end

    # Soft delete into the trash (both legs of a transfer).
    def delete(entry, actor: "user", batch_id: nil)
      locked do
        group(own(entry.id)).each do |record|
          next if record.deleted_at
          before = snapshot(record)
          record.update_columns(deleted_at: Time.current, updated_at: Time.current)
          audit("delete", record, before, snapshot(record), actor: actor, batch_id: batch_id)
        end
        touch
      end
    end

    def restore(entry, actor: "user")
      locked do
        group(own(entry.id, trashed: true)).each do |record|
          next unless record.deleted_at
          before = snapshot(record)
          record.deleted_at = nil
          validate_refund_integrity!(record)
          record.update_columns(deleted_at: nil, updated_at: Time.current)
          audit("restore", record, before, snapshot(record), actor: actor)
        end
        touch
      end
    end

    # Permanently removes a manual entry from the trash. Imported rows stay with their statement.
    def purge(entry, actor: "user")
      locked do
        record = own(entry.id, trashed: true)
        raise Invalid, "not_in_trash" unless record.deleted_at
        raise Invalid, "imported_entry" unless record.manual?
        group(record).each do |item|
          audit("purge", item, snapshot(item), {}, actor: actor)
          item.destroy!
        end
      end
    end

    # Applies one change to many entries: category, project, merchant, tag (added) or delete.
    def batch(ids, change, actor: "user")
      batch_id = SecureRandom.uuid
      entries = Transaction.live.where(user_id: @user.id, id: Array(ids).first(500)).order(:id).to_a
      raise Invalid, "nothing_selected" if entries.empty?
      if change[:action] == "delete"
        entries.each { |entry| delete(entry, actor: actor, batch_id: batch_id) }
        return entries.length
      end
      locked do
        entries.each do |entry|
          entry.lock!
          before = snapshot(entry)
          case change[:action]
          when "category"
            category = known_category!(change[:value])
            next if entry.transfer_like?
            entry.category = category
            entry.lock_fields!("category")
          when "project" then entry.project = change[:value].present? ? @user.finance_projects.find(change[:value]) : nil
          when "merchant" then entry.merchant = change[:value].present? ? @user.finance_merchants.find(change[:value]) : nil
          when "tag"
            tag = @user.finance_tags.find(change[:value])
            entry.tags << tag unless entry.tags.include?(tag)
          else raise Invalid, "unknown_action"
          end
          entry.save!
          audit("batch_update", entry, before, snapshot(entry), actor: actor, batch_id: batch_id)
        end
        touch
      end
      entries.length
    end

    # Undoes every audited change of one batch (AI apply, batch edit) that has not changed since.
    def undo_batch(batch_id, actor: "user")
      events = AuditEvent.where(user_id: @user.id, batch_id: batch_id).where(subject_type: "Transaction").where.not(action: "ai_undo").order(id: :desc).to_a
      raise Invalid, "nothing_to_undo" if events.empty?
      skipped = 0
      locked do
        events.each do |event|
          entry = Transaction.where(user_id: @user.id).find_by(id: event.subject_id)
          after = event.changes_data["after"] || {}
          if entry.nil? || after.any? { |field, value| current_value(entry, field) != value }
            skipped += 1
            next
          end
          before = snapshot(entry)
          (event.changes_data["before"] || {}).each do |field, value|
            if field == "tag_ids"
              entry.tag_ids = value
            else
              entry.public_send("#{field}=", (field == "deleted_at" && value) ? Time.zone.parse(value) : value)
            end
          end
          validate_refund_integrity!(entry)
          entry.save!(validate: false)
          audit("ai_undo", entry, before, snapshot(entry), actor: actor, batch_id: batch_id)
        end
        touch
      end
      {undone: events.length - skipped, skipped: skipped}
    end

    # Sets an account to the balance the person sees with an adjustment entry (余额).
    def adjust_balance(account, target, on: Date.current, note: nil)
      target = money!(target, allow_negative: true, allow_zero: true)
      current = account.balance(as_of: on)
      delta = target - current
      raise Invalid, "no_change" if delta.zero?
      create({kind: "adjustment", amount: delta.to_s("F"), booked_on: on.iso8601, account_id: account.id, note: note})
    end

    private

    def locked(&block)
      User.find(@user.id).with_lock(&block)
    rescue ActiveRecord::RecordInvalid => error
      raise Invalid, error.record.errors.details.flat_map { |field, details| details.map { |d| "#{field}_#{d[:error]}" } }
    rescue ActiveRecord::RecordNotFound
      raise Invalid, "not_found"
    end

    def own(id, trashed: false)
      scope = Transaction.where(user_id: @user.id)
      scope = scope.live unless trashed
      scope.find(id)
    end

    def find_account(id)
      return nil if id.blank?
      @user.finance_bank_accounts.find(id)
    end

    def normalize(params, partial: false)
      p = params.to_h.symbolize_keys
      p[:kind] = p[:kind].to_s if p.key?(:kind)
      p[:kind] = "expense" if !partial && p[:kind].blank?
      p
    end

    def money!(value, allow_negative: false, allow_zero: false)
      amount = value.is_a?(BigDecimal) ? value : BigDecimal(value.to_s.strip.delete(","), exception: false)
      raise Invalid, "amount_required" if amount.nil? || !amount.finite?
      raise Invalid, "amount_precision" if amount != amount.round(2)
      raise Invalid, "amount_too_large" if amount.abs >= 10**13
      raise Invalid, "amount_zero" if amount.zero? && !allow_zero
      allow_negative ? amount : amount.abs
    end

    def date!(value)
      value.is_a?(Date) ? value : Date.iso8601(value.to_s)
    rescue Date::Error
      raise Invalid, "date_invalid"
    end

    def known_category!(name)
      name = name.to_s
      raise Invalid, "category_unknown" unless tree.names.include?(name)
      name
    end

    def validate!(p, account, to_account: nil, refund_of: :unset)
      codes = Domain.entry_problems(kind: p[:kind], amount: p[:amount], occurred_on: p[:booked_on], account_id: account&.id,
        to_account_id: to_account&.id, category_kind: p[:category].present? ? tree.kind_of(p[:category].to_s) : nil, refund_of: refund_of)
      codes << "kind_invalid" unless MANUAL_KINDS.include?(p[:kind]) || p[:kind] == "card_payment"
      raise Invalid, codes.uniq if codes.any?
    end

    def dimensions(p)
      merchant = if p[:merchant_id].present? then @user.finance_merchants.find(p[:merchant_id])
      elsif p[:merchant_name].present? then find_or_create_dimension(Merchant, p[:merchant_name])
      end
      project = p[:project_id].present? ? @user.finance_projects.find(p[:project_id]) : nil
      tags = Array(p[:tag_ids]).compact_blank.map { |id| @user.finance_tags.find(id) }
      tags += p[:tag_names].to_s.split(/[,，]/).map(&:squish).compact_blank.map { |name| find_or_create_dimension(Tag, name) }
      {merchant: merchant, project: project, tags: tags.uniq}
    end

    def find_or_create_dimension(model, name)
      name = name.to_s.squish.first(60)
      model.where(user_id: @user.id).where("lower(name) = ?", name.downcase).first || model.create!(user: @user, name: name).tap do |record|
        audit("create", record, {}, {"name" => record.name})
      end
    end

    def create_single(p, account, actor, batch_id, origin, recurring)
      refund_target = (p[:kind] == "refund" && p[:refund_of_id].present?) ? own(p[:refund_of_id]) : nil
      refund_info = if p[:kind] != "refund" then :unset
      elsif refund_target then {amount: refund_target.amount, refunded: refunded_total(refund_target)}
      end
      validate!(p, account, refund_of: (p[:kind] == "refund" && p[:refund_of_id].present?) ? refund_info : :unset)
      raise Invalid, "refund_target_invalid" if refund_target && !%w[expense].include?(refund_target.kind)
      amount = Domain.signed_amount(p[:kind], money!(p[:amount]))
      category = p[:category].presence || refund_target&.category || "Uncategorized"
      known_category!(category)
      category = "Uncategorized" if category == "Transfers"
      dims = dimensions(p)
      entry = Transaction.new(user: @user, bank_account: account, entry_origin: origin, kind: p[:kind], amount: amount,
        booked_on: date!(p[:booked_on]), occurred_at_time: p[:occurred_at_time].presence, category: category,
        description: description_for(p, dims[:merchant], category), note: p[:note].presence, merchant: dims[:merchant] || refund_target&.merchant,
        project: dims[:project] || refund_target&.project, category_source: "user", tax_review: category == "Business",
        recurring_rule: recurring&.first, recurring_on: recurring&.last)
      entry.user_locked_fields = %w[category kind]
      entry.tags = dims[:tags]
      entry.save!
      if refund_target
        TransactionLink.create!(user: @user, link_type: "refund_of", from_transaction: entry, to_transaction: refund_target, amount: amount.abs, status: "confirmed", decided_by: "user")
      end
      audit("create", entry, {}, snapshot(entry), actor: actor, batch_id: batch_id)
      touch
      entry
    end

    def create_transfer(p, from, to, actor, batch_id, origin, recurring)
      validate!(p.merge(category: nil), from, to_account: to)
      amount = money!(p[:amount])
      kind = Domain.transfer_kind(to.account_type)
      dims = dimensions(p)
      date = date!(p[:booked_on])
      legs = [[from, -amount], [to, amount]].map do |account, signed|
        Transaction.create!(user: @user, bank_account: account, entry_origin: origin, kind: kind, amount: signed, booked_on: date,
          occurred_at_time: p[:occurred_at_time].presence, category: "Transfers", category_source: "user", note: p[:note].presence,
          description: p[:description].presence || transfer_description(from, to), project: dims[:project], user_locked_fields: %w[kind],
          recurring_rule: recurring&.first, recurring_on: recurring&.last)
      end
      TransactionLink.create!(user: @user, link_type: kind, from_transaction: legs[0], to_transaction: legs[1], status: "confirmed", decided_by: "user")
      legs.each { |leg| audit("create", leg, {}, snapshot(leg), actor: actor, batch_id: batch_id) }
      touch
      legs[0]
    end

    def create_adjustment(p, account, actor, batch_id)
      validate!(p.merge(category: nil), account)
      amount = money!(p[:amount], allow_negative: true)
      entry = Transaction.create!(user: @user, bank_account: account, entry_origin: "manual", kind: "adjustment", amount: amount,
        booked_on: date!(p[:booked_on]), category: "Transfers", category_source: "user", note: p[:note].presence,
        description: p[:description].presence || I18n.t("billie.ledger.kinds.adjustment"), user_locked_fields: %w[kind])
      audit("create", entry, {}, snapshot(entry), actor: actor, batch_id: batch_id)
      touch
      entry
    end

    def apply_manual(entry, p)
      kind = p[:kind].presence || entry.kind
      account = p.key?(:account_id) ? find_account(p[:account_id]) : entry.bank_account
      typed = p.key?(:amount) ? money!(p[:amount], allow_negative: kind == "adjustment") : entry.amount.abs
      date = p.key?(:booked_on) ? date!(p[:booked_on]) : entry.booked_on
      category = p.key?(:category) ? known_category!(p[:category]) : entry.category
      if Transaction::TRANSFER_LIKE.include?(kind)
        category = "Transfers"
      else
        category = "Uncategorized" if category == "Transfers"
        validate!({kind: kind, amount: typed.to_s("F"), booked_on: date.iso8601, category: category}, account)
      end
      if kind == "refund" && (link = entry.outgoing_links.find_by(link_type: "refund_of"))
        cap = Domain.refundable(link.to_transaction.amount, [refunded_total(link.to_transaction) - link.amount.to_d])
        raise Invalid, "refund_too_large" if typed > cap
        link.update!(amount: typed)
      end
      entry.assign_attributes(kind: kind, bank_account: account, booked_on: date, category: category,
        amount: (kind == "adjustment") ? typed : Domain.signed_amount(kind, typed))
      apply_common(entry, p)
    end

    def update_transfer(entry, leg, p)
      from, to = entry.amount.negative? ? [entry, leg] : [leg, entry]
      amount = p.key?(:amount) ? money!(p[:amount]) : from.amount.abs
      date = p.key?(:booked_on) ? date!(p[:booked_on]) : from.booked_on
      from_account = p[:account_id].present? ? find_account(p[:account_id]) : from.bank_account
      to_account = p[:to_account_id].present? ? find_account(p[:to_account_id]) : to.bank_account
      raise Invalid, "accounts_same" if from_account == to_account
      kind = Domain.transfer_kind(to_account.account_type)
      leg_before = snapshot(leg)
      from.assign_attributes(bank_account: from_account, amount: -amount, booked_on: date, kind: kind)
      to.assign_attributes(bank_account: to_account, amount: amount, booked_on: date, kind: kind)
      [from, to].each { |record| apply_common(record, p.except(:merchant_id, :merchant_name)) }
      leg.save!
      TransactionLink.where(user_id: @user.id, from_transaction_id: [from.id, to.id]).where(link_type: %w[transfer card_payment]).update_all(link_type: kind)
      audit("update", leg, leg_before, snapshot(leg))
    end

    def apply_display(entry, p)
      if p.key?(:category)
        entry.category = known_category!(p[:category])
      end
      if p[:kind].present? && p[:kind] != entry.kind
        raise Invalid, "kind_invalid" unless Transaction::KINDS.include?(p[:kind])
        entry.kind = p[:kind]
        entry.category = "Transfers" if entry.transfer_like?
        entry.category = "Uncategorized" if !entry.transfer_like? && entry.category == "Transfers"
      end
      apply_common(entry, p)
    end

    def apply_common(entry, p)
      entry.description = p[:description].to_s.squish.first(500) if p[:description].present?
      entry.note = p[:note].presence if p.key?(:note)
      entry.occurred_at_time = p[:occurred_at_time].presence if p.key?(:occurred_at_time)
      %i[excluded tax_review].each { |flag| entry.public_send("#{flag}=", ActiveModel::Type::Boolean.new.cast(p[flag]) || false) if p.key?(flag) }
      if p.key?(:merchant_id) || p.key?(:merchant_name) || p.key?(:project_id) || p.key?(:tag_ids) || p.key?(:tag_names)
        dims = dimensions(p)
        entry.merchant = dims[:merchant] if p.key?(:merchant_id) || p.key?(:merchant_name)
        entry.project = dims[:project] if p.key?(:project_id)
        entry.tags = dims[:tags] if p.key?(:tag_ids) || p.key?(:tag_names)
      end
      entry.category_source = "user" if entry.will_save_change_to_category?
    end

    def locked_fields_for(p, entry)
      fields = []
      fields << "category" if entry.will_save_change_to_category? || p.key?(:category)
      fields << "kind" if entry.will_save_change_to_kind?
      fields << "description" if entry.will_save_change_to_description?
      fields << "excluded" if entry.will_save_change_to_excluded?
      fields << "merchant" if entry.will_save_change_to_merchant_id?
      fields << "project" if entry.will_save_change_to_project_id?
      fields << "account" if entry.will_save_change_to_bank_account_id?
      fields
    end

    def refunded_total(expense)
      TransactionLink.confirmed.joins(:from_transaction).where(link_type: "refund_of", to_transaction_id: expense.id, finance_transactions: {deleted_at: nil}).sum("finance_transactions.amount")
    end

    # Creation is only one way the cap can change: restoring a trashed refund and reducing or
    # reclassifying its expense must satisfy the same invariant, under the same per-user lock.
    def validate_refund_integrity!(entry)
      received = refunded_total(entry)
      if received.positive? && (entry.kind != "expense" || entry.amount >= 0 || received > -entry.amount)
        raise Invalid, "refund_too_large"
      end
      return if entry.deleted_at || entry.kind != "refund"
      entry.outgoing_links.confirmed.where(link_type: "refund_of").each do |link|
        target = link.to_transaction
        other_refunds = TransactionLink.confirmed.joins(:from_transaction).where(link_type: "refund_of", to_transaction_id: target.id,
          finance_transactions: {deleted_at: nil}).where.not(from_transaction_id: entry.id).sum("finance_transactions.amount")
        if target.kind != "expense" || entry.amount <= 0 || other_refunds + entry.amount > -target.amount
          raise Invalid, "refund_too_large"
        end
      end
    end

    def transfer_partner(entry)
      return nil unless %w[transfer card_payment].include?(entry.kind)
      link = TransactionLink.where(user_id: @user.id, link_type: %w[transfer card_payment]).where("from_transaction_id = :id OR to_transaction_id = :id", id: entry.id).first
      return nil unless link
      other_id = (link.from_transaction_id == entry.id) ? link.to_transaction_id : link.from_transaction_id
      other_id && Transaction.where(user_id: @user.id).find_by(id: other_id)
    end

    # An entry plus the other leg of its manual transfer (deleted and restored together).
    def group(entry)
      partner = entry.manual? ? transfer_partner(entry) : nil
      [entry, partner].compact
    end

    def description_for(p, merchant, category)
      p[:description].to_s.squish.presence || merchant&.name || I18n.t("billie.backend.categories.#{category}", default: category)
    end

    def transfer_description(from, to)
      "#{from.display_name} → #{to.display_name}"
    end

    def snapshot(entry)
      return {} unless entry.respond_to?(:attributes)
      values = entry.attributes.slice(*AUDITED).transform_values { |value| comparable(value) }
      values["tag_ids"] = entry.tag_ids.sort if entry.is_a?(Transaction)
      values
    end

    def current_value(entry, field)
      (field == "tag_ids") ? entry.tag_ids.sort : comparable(entry.public_send(field))
    end

    def comparable(value)
      case value
      when BigDecimal then value.to_s("F")
      when Date then value.iso8601
      when Time, ActiveSupport::TimeWithZone then value.utc.iso8601
      else value
      end
    end

    def audit(action, record, before, after, actor: "user", batch_id: nil)
      changed = (before.keys | after.keys).reject { |key| before[key] == after[key] }
      AuditEvent.record!(user: @user, action: action, subject: record, actor: actor, batch_id: batch_id,
        summary: record.try(:description) || record.try(:name),
        changes: {"before" => before.slice(*changed), "after" => after.slice(*changed)})
    end

    def touch
      Profile.where(user_id: @user.id).touch_all
    end
  end
end
