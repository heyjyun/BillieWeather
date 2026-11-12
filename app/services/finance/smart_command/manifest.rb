module Finance
  module SmartCommand
    # The website's command registry, generated from packages/billie-commands (the single source of
    # command definitions for every platform) by packages/billie-commands/scripts/build-web.mjs.
    # The trusted side reads risk, confirmation and parameter rules from here, never from the browser.
    class Manifest
      PATH = Rails.root.join("config/smart_command/web-manifest.json")
      PROTOCOL = "nlae/1"

      def self.current
        # Re-read in development so a rebuilt manifest takes effect without a restart.
        return load_file if Rails.env.development?
        @current ||= load_file
      end

      def self.load_file
        new(JSON.parse(File.read(PATH)))
      end

      attr_reader :product, :version

      def initialize(data)
        raise ArgumentError, "unsupported command protocol" unless data["protocol"] == PROTOCOL
        @product = data.fetch("product")
        @version = data.fetch("version")
        @actions = data.fetch("actions").to_h { |action| [action.fetch("id"), action.freeze] }.freeze
      end

      def action(id)
        @actions[id] if id.is_a?(String)
      end

      def action_ids
        @actions.keys
      end

      # Same rule as confirmationFor in @nlae/core: data changes need at least an explicit yes,
      # high risk a typed phrase; a definition may raise (never lower) that.
      def confirmation_for(action)
        order = %w[none confirm typed]
        implied = case action["risk"]
        when "none" then "none"
        when "high" then "typed"
        else "confirm"
        end
        requested = action["confirmation"] || "none"
        (order.index(requested).to_i > order.index(implied)) ? requested : implied
      end
    end
  end
end
