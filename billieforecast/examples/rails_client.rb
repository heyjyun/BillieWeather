# Copy this class into Rails if/when you wire up its CashFlowForecast service.
# Requires no additional gems. Pass ordered daily aggregates, never transaction descriptions.
require "json"
require "net/http"
require "uri"

module Finance
  class BillieForecastClient
    class Unavailable < StandardError; end

    def initialize(url: ENV.fetch("BILLIEFORECAST_URL", "http://127.0.0.1:8000"),
      api_key: ENV["BILLIEFORECAST_API_KEY"])
      @url = URI("#{url.sub(%r{/$}, "")}/v1/forecast")
      @api_key = api_key
    end

    def call(history:, starting_balance:, days: 30, currency: "USD",
      income_adjustment: 0, expense_adjustment: 0)
      request = Net::HTTP::Post.new(@url)
      request["Content-Type"] = "application/json"
      request["X-API-Key"] = @api_key if @api_key && !@api_key.empty?
      request.body = JSON.generate(history: history, starting_balance: starting_balance.to_s,
        days: days, currency: currency, income_adjustment: income_adjustment.to_s,
        expense_adjustment: expense_adjustment.to_s)
      response = Net::HTTP.start(@url.host, @url.port, use_ssl: @url.scheme == "https",
        open_timeout: 3, read_timeout: 120) { |http| http.request(request) }
      unless response.is_a?(Net::HTTPSuccess)
        raise Unavailable, "BillieForecast returned HTTP #{response.code}."
      end

      result = JSON.parse(response.body)
      unless result.is_a?(Hash) && result["points"].is_a?(Array) && result["points"].length == days
        raise Unavailable, "BillieForecast returned an unexpected response."
      end
      result
    rescue JSON::ParserError, IOError, SystemCallError, Timeout::Error, SocketError
      raise Unavailable, "BillieForecast is unavailable."
    end
  end
end
