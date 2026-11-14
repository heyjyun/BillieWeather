module Finance
  # One-time clean-up of local database METADATA written by older apps, whose device id lived in
  # WebView storage (a new one per origin, build or cleared storage) and whose browser preview
  # reported throw-away in-memory databases under a new database id on every page load.
  #
  # Only rows on legacy devices (never reported a platform) are considered. Nothing is deleted:
  # rows are re-labelled (active → archived or review) and every change is written to the audit
  # trail with the evidence and the previous snapshot. Financial tables are never read or written.
  # Running it again changes nothing (only still-active legacy rows are planned).
  #
  # Evidence rules, strongest first. Matching names, sizes or counts are never enough alone:
  #   duplicate_snapshot   The SAME random database id (minted inside one SQLite file) under several
  #                        legacy devices, and the older snapshot is identical to the newest one.
  #                        The newest stays active; older ones are archived.
  #   diverged_copy        Same database id, but the snapshots differ: possibly a copied file that
  #                        was changed independently. Sent to review, never merged.
  #   ephemeral_preview    A legacy device that reported two or more different, empty, never-named
  #                        databases and nothing else. A real SQLite file keeps its id, so ids that
  #                        change on every launch can only come from in-memory preview databases.
  #   unverified_empty     A single empty, never-named database on a legacy device: kept for review.
  #   keep                 Anything else (a real, non-empty database seen once) stays as it is.
  class LocalDatabaseConsolidation
    UNNAMED = "Unnamed database"

    Action = Struct.new(:report_id, :user_id, :device_id, :database_id, :decision, :reason, :evidence, keyword_init: true) do
      def to_h = super.merge(decision: decision.to_s, reason: reason.to_s)
    end

    def initialize(users: User.all)
      @users = users
    end

    def plan
      user_ids = Finance::LocalDatabaseReport.active.where(user_id: @users.select(:id)).distinct.pluck(:user_id).sort
      user_ids.flat_map { |user_id| plan_for(user_id) }
    end

    # Applies the plan. Returns the actions taken. Rows changed since planning are skipped.
    def apply!(actions = plan)
      now = Time.current
      actions.reject { |action| action.decision == :keep }.group_by(&:user_id).flat_map do |user_id, user_actions|
        Finance::LocalDatabaseReport.transaction do
          User.where(id: user_id).lock.pick(:id)
          user_actions.filter_map do |action|
            row = Finance::LocalDatabaseReport.active.find_by(id: action.report_id, user_id: user_id)
            next unless row # already handled: idempotent
            Finance::LocalDatabaseAudit.record!(user_id: user_id, event: (action.decision == :archive) ? "legacy_archived" : "legacy_review",
              device_id: row.device_id, database_id: row.database_id, reason: action.reason.to_s, evidence: action.evidence,
              previous_status: row.status, snapshot: row.snapshot)
            row.set_status!((action.decision == :archive) ? "archived" : "review", action.reason.to_s, now)
            action
          end
        end
      end
    end

    def self.describe(actions)
      return "No legacy local database records need attention." if actions.empty?
      lines = actions.group_by(&:user_id).flat_map do |user_id, user_actions|
        counts = user_actions.map(&:decision).tally
        rows = Finance::LocalDatabaseReport.where(id: user_actions.map(&:report_id)).index_by(&:id)
        ["user #{user_id}: #{user_actions.size} active legacy record(s) → keep #{counts[:keep].to_i}, archive #{counts[:archive].to_i}, review #{counts[:review].to_i}"] +
          user_actions.map do |action|
            row = rows[action.report_id]
            Kernel.format("  #%-5s device %s… database %s… %-16s %8s B %3s stmt %5s txn  → %-7s %s",
              action.report_id, action.device_id[0, 8], action.database_id[0, 8], row&.name.to_s.truncate(16), row&.size_bytes,
              row&.statement_count, row&.transaction_count, action.decision, action.reason)
          end
      end
      lines.join("\n")
    end

    private

    def plan_for(user_id)
      legacy_devices = Finance::LocalDevice.where(user_id: user_id, platform: nil).pluck(:device_id)
      rows = Finance::LocalDatabaseReport.active.where(user_id: user_id, device_id: legacy_devices).order(:reported_at, :id).to_a
      decided = {}

      rows.group_by(&:database_id).each_value do |same_database|
        next if same_database.size < 2
        newest = same_database.max_by { |row| [row.reported_at, row.id] }
        decided[newest.id] = action(newest, :keep, :newest_snapshot, devices: same_database.map(&:device_id).uniq.sort)
        (same_database - [newest]).each do |older|
          identical = comparable(older) == comparable(newest)
          decided[older.id] = action(older, identical ? :archive : :review, identical ? :duplicate_snapshot : :diverged_copy,
            same_database_id_as: newest.id, newest_device_id: newest.device_id, snapshots_identical: identical)
        end
      end

      rows.reject { |row| decided.key?(row.id) }.group_by(&:device_id).each do |device_id, device_rows|
        throwaway = device_rows.select { |row| throwaway?(row) }
        others_on_device = rows.select { |row| row.device_id == device_id } - throwaway
        rotating = throwaway.map(&:database_id).uniq.size >= 2 && others_on_device.none? { |row| !row.empty_database? }
        device_rows.each do |row|
          decided[row.id] =
            if throwaway.include?(row) && rotating
              action(row, :archive, :ephemeral_preview, empty_unnamed_ids_on_device: throwaway.size)
            elsif throwaway.include?(row)
              action(row, :review, :unverified_empty)
            else
              action(row, :keep, :only_snapshot)
            end
        end
      end
      rows.map { |row| decided.fetch(row.id) }
    end

    def throwaway?(row) = row.empty_database? && row.name == UNNAMED

    def comparable(row) = row.attributes.slice("statement_count", "transaction_count", "rule_count", "period_start", "period_end", "modified_at", "size_bytes")

    def action(row, decision, reason, **evidence)
      Action.new(report_id: row.id, user_id: row.user_id, device_id: row.device_id, database_id: row.database_id,
        decision: decision, reason: reason, evidence: evidence)
    end
  end
end
