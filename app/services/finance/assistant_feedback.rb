module Finance
  class AssistantFeedback
    class Invalid < StandardError; end
    PREFERENCES = %w[enabled organization planning].freeze
    PORTABLE = (PREFERENCES + %w[account import classify duplicates matches budget forecast report]).freeze
    SUBJECT = /\A(?:reconcile|discover|recurring):[1-9]\d{0,18}\z/
    STATUS = %w[accepted deferred dismissed completed invalidated].freeze

    def self.portable(state)
      state.slice(*PORTABLE).select { |key,value| PREFERENCES.include?(key) || %w[dismissed deferred].include?(value["status"]) }
    end

    def self.apply(profile, key, value, portable_only: false, expected: :any)
      raise Invalid unless PORTABLE.include?(key) || (!portable_only && key.is_a?(String) && key.match?(SUBJECT))
      if PREFERENCES.include?(key)
        raise Invalid unless value == true || value == false
      else
        raise Invalid unless value.is_a?(Hash) && STATUS.include?(value["status"])
        raise Invalid if portable_only && !%w[dismissed deferred].include?(value["status"])
        value = value.slice("status", "until")
        if value["status"] == "deferred" || (value["status"] == "completed" && value.key?("until"))
          raise Invalid unless value["until"].is_a?(Integer) && value["until"].between?(0, 8.days.from_now.to_i * 1000)
        else
          value.delete("until")
        end
      end
      profile.with_lock do
        state = profile.assistant_state
        current = portable_only ? portable(state)[key] : state[key]
        return state if expected != :any && current != expected
        profile.update!(assistant_state: state.merge(key => value))
        profile.assistant_state
      end
    end
  end
end
