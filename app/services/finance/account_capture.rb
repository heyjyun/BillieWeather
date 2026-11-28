module Finance
  # A reviewed proposal never contains raw OCR or the person's original text.
  class AccountCapture
    class Invalid < StandardError; end
    class Duplicate < Invalid; end
    ACTION = "accounts.create_batch"
    UUID = /\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/i
    FIELDS = %w[name type currency institution last4 amount date].freeze

    def initialize(user, currency)
      @user, @currency = user, currency
    end

    def call(key:, rows:, source:, confirmed:)
      raise Invalid unless confirmed == true && key.is_a?(String) && key.match?(UUID)
      raise Invalid unless %w[text screenshot].include?(source) && rows.is_a?(Array) && rows.size.between?(1, 20)
      origins = rows.map do |row|
        raise Invalid unless row.is_a?(Hash)
        evidence = row.fetch("origins", {})
        raise Invalid unless evidence.is_a?(Hash) && (evidence.keys - FIELDS).empty? && (evidence.values - [source,"suggested","edited","unknown"]).empty?
        evidence
      end
      attributes = rows.map { |row| attributes_for(row.except("origins")) }
      digest = Digest::SHA256.hexdigest([ACTION, source, attributes, origins].to_json)
      @user.with_lock do
        execution = @user.finance_command_executions.find_by(idempotency_key: key)
        if execution
          raise Invalid unless execution.action_id == ACTION && execution.request_digest == digest && execution.undone_at.nil?
          ids = execution.result.fetch("ids")
          raise Invalid unless @user.finance_bank_accounts.where(id: ids).count == ids.size
          next ids
        end
        sort = @user.finance_bank_accounts.maximum(:sort_order).to_i
        ids = attributes.each_with_index.map do |attrs,index|
          account = @user.finance_bank_accounts.new(attrs.merge(manual: true, sort_order: sort += 1))
          matches = @user.finance_bank_accounts.where("LOWER(COALESCE(NULLIF(custom_name,''), name)) = LOWER(?)", account.name)
          raise Duplicate if matches.exists? || (account.identity_key && @user.finance_bank_accounts.exists?(identity_key: account.identity_key))
          account.save!
          AuditEvent.record!(user: @user, actor: "user", action: "create", subject: account, summary: account.display_name,
            batch_id: key, changes: {source: source, origins: origins[index], confirmed: true, balance_pending: account.balance_pending, fields: attrs.except(:identity_key)})
          account.id
        end
        accounts = @user.finance_bank_accounts.where(id: ids)
        @user.finance_command_executions.create!(idempotency_key: key, action_id: ACTION, request_digest: digest, result: {ids: ids},
          undo_payload: accounts.to_h { |a| [a.id.to_s, fingerprint(a)] }, undo_expires_at: 1.day.from_now)
        ids
      end
    end

    def undo(key)
      @user.with_lock do
        execution = @user.finance_command_executions.find_by!(action_id: ACTION,idempotency_key: key)
        return if execution.undone_at?
        raise Invalid unless execution.undo_expires_at&.future?
        ids = execution.result.fetch("ids")
        records = @user.finance_bank_accounts.where(id: ids).order(:id).lock.to_a
        raise Invalid unless records.size == ids.size && records.all? { |a| execution.undo_payload[a.id.to_s] == fingerprint(a) }
        raise Invalid if @user.finance_transactions.where(bank_account_id: ids).exists? || @user.finance_statements.where(bank_account_id: ids).exists? ||
          @user.finance_statement_drafts.where(bank_account_id: ids).exists? || @user.finance_receipts.where(bank_account_id: ids).exists? ||
          @user.finance_recurring_rules.where("template->>'account_id' IN (:ids) OR template->>'to_account_id' IN (:ids)", ids: ids.map(&:to_s)).exists?
        records.each do |account|
          AuditEvent.record!(user: @user, action: "delete", subject: account, batch_id: key, changes: {undo: ACTION})
          account.destroy!
        end
        execution.update!(undone_at: Time.current)
      end
    end

    private

    def fingerprint(account)
      Digest::SHA256.hexdigest(account.attributes.sort.to_json)
    end

    def attributes_for(row)
      raise Invalid unless row.is_a?(Hash) && (row.keys - FIELDS).empty? && row.values.all? { |v| v.is_a?(String) }
      name, type, currency, bank, suffix, amount, date = FIELDS.map { |key| row[key].to_s.strip }
      raise Invalid unless name.length.between?(1, 60) && BankAccount::TYPES.include?(type) && currency == @currency
      raise Invalid unless bank.size <= 60 && (suffix.empty? || suffix.match?(/\A\d{4}\z/))
      raise Invalid unless date.empty? || date.match?(/\A\d{4}-\d{2}-\d{2}\z/)
      raise Invalid unless amount.empty? || amount.match?(/\A-?\d{1,12}(?:\.\d{1,2})?\z/)
      raise Invalid if amount.present? && date.blank?
      day = Date.iso8601(date) if date.present?
      today = Time.current.in_time_zone(@user.time_zone.presence || "America/Chicago").to_date
      raise Invalid if day && day > today
      signed = amount.presence&.to_d
      signed = -signed if signed && Domain.liability?(type)
      {name: name, custom_name: name, account_type: type, currency: currency, bank_name: bank.presence, last4: suffix.presence,
       balance_snapshot: signed.present? && date.present?, opening_balance: signed || 0, balance_pending: signed.nil?, opening_balance_on: day,
       identity_key: BankAccount.statement_key(bank, suffix, type)}
    rescue Date::Error
      raise Invalid
    end
  end
end
