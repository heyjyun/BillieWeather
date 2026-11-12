module Finance
  module SmartCommand
    # A command the trusted side refuses (nothing ran): a stable code the browser translates, with
    # English text as fallback. `summary_code` lets a handler explain a no-op ("no_match").
    class Rejection < StandardError
      attr_reader :code, :summary

      def initialize(code, message, vars = {}, summary_code: nil)
        @code = code
        @summary = {code: summary_code || code, message: message, vars: vars}
        super(message)
      end
    end
  end
end
