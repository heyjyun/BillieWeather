module Finance
  # A data-changing command run from the website's command bar: its idempotency key, the stored
  # result for replays, and (for a limited time) what Undo needs. See Finance::SmartCommand::Executor.
  class CommandExecution < ActiveRecord::Base
    self.table_name = "finance_command_executions"

    # Repeated submissions with the same key within this window replay the first result.
    RETENTION = 1.day

    belongs_to :user

    validates :idempotency_key, :action_id, :request_digest, presence: true

    def self.prune!(user)
      where(user_id: user.id).where("created_at < ?", RETENTION.ago).delete_all
    end
  end
end
