module Finance
  # The browser session stores the user's accounting workflow. Both workflows share the ledger.
  module ManualWorkspace
    SESSION_KEY = :billie_mode
    MODES = %w[default manual].freeze
  end
end
