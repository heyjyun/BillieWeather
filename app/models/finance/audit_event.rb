module Finance
  # Append-only record of every change to financial records (操作日志), with the data needed to undo
  # it. Values are stored (privacy decision Q10: the person's own data, never shared, deleted with
  # "Delete my financial data"). Read-only once saved.
  class AuditEvent < ActiveRecord::Base
    self.table_name = "finance_audit_events"

    belongs_to :user

    validates :actor, inclusion: {in: Domain::AUDIT_ACTORS}
    validates :action, inclusion: {in: Domain::AUDIT_ACTIONS}
    validates :subject_type, presence: true

    scope :newest_first, -> { order(created_at: :desc, id: :desc) }

    def readonly?
      persisted?
    end

    def self.record!(user:, action:, subject:, actor: "user", changes: {}, undo: nil, summary: nil, batch_id: nil)
      subject_type, subject_id = subject.is_a?(Array) ? subject : [subject.class.name.demodulize, subject.id]
      create!(user: user, actor: actor, action: action, subject_type: subject_type, subject_id: subject_id&.to_s,
        changes_data: changes, undo_data: undo, summary: summary&.to_s&.first(300), batch_id: batch_id, created_at: Time.current)
    end
  end
end
