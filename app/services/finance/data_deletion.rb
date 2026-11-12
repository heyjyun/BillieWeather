module Finance
  # "Delete my financial data": removes every finance record that belongs to one person and
  # keeps their login. BillieWeather does not store uploaded statement files (they are parsed
  # in memory and only the extracted rows are saved), and no background jobs hold finance
  # data, so the database rows below plus the cached forecast are everything there is.
  #
  # Deletion runs under the same per-user row lock that statement imports and balance
  # syncing take, inside one database transaction: it either removes everything or nothing.
  class DataDeletion
    # Order matters: children before the rows their foreign keys point at.
    MODELS = [CommandExecution, Transaction, StatementDraft, Statement, BankAccount, MerchantRule, CustomCategory, Insight, Profile].freeze

    def self.call(user:)
      new(user: user).call
    end

    def initialize(user:)
      raise ArgumentError, "a saved user is required" unless user&.persisted?
      @user = user
    end

    # Returns {table_name => rows deleted}.
    def call
      counts = User.find(@user.id).with_lock { delete_records! }
      self.class.clear_cached_forecasts(@user.id)
      counts
    end

    # For callers that already hold the user's lock inside their own transaction.
    def delete_records!
      MODELS.to_h { |model| [model.table_name, model.where(user_id: @user.id).delete_all] }
    end

    # Prophet forecasts are cached for up to 12 hours under keys that start with the user's id.
    # Takes an id so it also works after the user record itself is gone.
    # Redis matches a glob; the in-process stores turn a String into a Regexp, so they get an anchored one.
    def self.clear_cached_forecasts(user_id, cache: Rails.cache)
      prefix = "finance/prophet/v1/#{Integer(user_id)}/"
      matcher = cache.is_a?(ActiveSupport::Cache::RedisCacheStore) ? "#{prefix}*" : /\A#{Regexp.escape(prefix)}/
      cache.delete_matched(matcher)
    rescue NotImplementedError
      # A store that cannot match keys: entries still expire within 12 hours and are keyed by the
      # deleted data's timestamps, so they can no longer be read for this person.
      nil
    rescue => error
      # The records are already gone; a cache outage must not turn that into an error page.
      Rails.logger.warn("Forecast cache could not be cleared for user #{user_id}: #{error.class}")
      nil
    end
  end
end
