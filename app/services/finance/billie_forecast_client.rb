require "bigdecimal"
require "date"
require "json"
require "net/http"
require "uri"

module Finance
  class BillieForecastClient
    class Unavailable < StandardError; end

    MAX_RESPONSE_BYTES = 1.megabyte

    def initialize(url: ENV.fetch("BILLIEFORECAST_URL", "http://127.0.0.1:8000"),
      api_key: ENV["BILLIEFORECAST_API_KEY"])
      @url = URI.parse(url.to_s)
      unless @url.is_a?(URI::HTTP) && @url.host.to_s.length.positive? &&
          @url.userinfo.nil? && @url.query.nil? && @url.fragment.nil?
        raise Unavailable, "Chronos-2 service URL is invalid. Check BILLIEFORECAST_URL."
      end
      @url.path = "#{@url.path.sub(%r{/+\z}, "")}/v1/forecast"
      @api_key = api_key
    rescue URI::InvalidURIError, URI::InvalidComponentError
      raise Unavailable, "Chronos-2 service URL is invalid. Check BILLIEFORECAST_URL."
    end

    def call(history:, starting_balance:, days: 30, currency: "USD",
      income_adjustment: 0, expense_adjustment: 0)
      payload = request_payload(history, starting_balance, days, currency,
        income_adjustment, expense_adjustment)
      result = JSON.parse(request_body(payload))
      validate_result!(result, payload)
      result
    rescue JSON::ParserError, KeyError, ArgumentError, TypeError, RangeError
      raise Unavailable, "Chronos-2 service returned an invalid forecast."
    rescue Timeout::Error, SocketError, IOError, SystemCallError,
      OpenSSL::SSL::SSLError, Net::HTTPBadResponse,
      Net::HTTPHeaderSyntaxError, Net::ProtocolError
      raise Unavailable, "Chronos-2 service is temporarily unavailable. Check BillieForecast and try again."
    end

    private

    def request_payload(history, starting_balance, days, currency, income_adjustment, expense_adjustment)
      invalid_result! unless history.is_a?(Array) && history.length.between?(3, 90)
      invalid_result! unless days.is_a?(Integer) && days.between?(1, 90)
      invalid_result! unless currency.is_a?(String) && currency.match?(/\A[A-Z]{3}\z/)

      daily_history = history.map do |day|
        date = day.fetch(:date) { day.fetch("date") }
        income = decimal(day.fetch(:income) { day.fetch("income") })
        expenses = decimal(day.fetch(:expenses) { day.fetch("expenses") })
        invalid_result! if income.negative? || expenses.negative?
        {date: Date.iso8601(date.to_s).iso8601,
         income: income.to_s("F"), expenses: expenses.to_s("F")}
      end
      daily_history.each_cons(2) do |previous, current|
        invalid_result! unless Date.iso8601(current[:date]) == Date.iso8601(previous[:date]) + 1
      end
      income_adjustment = decimal(income_adjustment, cents: false)
      expense_adjustment = decimal(expense_adjustment, cents: false)
      invalid_result! unless [income_adjustment, expense_adjustment].all? { |value| value.between?(-100, 1000) }

      {history: daily_history, starting_balance: decimal(starting_balance).to_s("F"),
       days: days, currency: currency, income_adjustment: income_adjustment.to_s("F"),
       expense_adjustment: expense_adjustment.to_s("F")}
    end

    def request_body(payload)
      request = Net::HTTP::Post.new(@url)
      request["Content-Type"] = "application/json"
      request["X-API-Key"] = @api_key if @api_key && !@api_key.empty?
      request.body = JSON.generate(payload)
      http = Net::HTTP.new(@url.host, @url.port)
      http.use_ssl = @url.scheme == "https"
      http.open_timeout = 3
      http.read_timeout = 120
      http.write_timeout = 10
      http.max_retries = 0
      body = +""
      Timeout.timeout(125) do
        http.request(request) do |response|
          unless response.is_a?(Net::HTTPSuccess)
            raise Unavailable, "Chronos-2 service returned HTTP #{response.code}. Check BillieForecast and try again."
          end
          response.read_body do |chunk|
            body << chunk
            invalid_result! if body.bytesize > MAX_RESPONSE_BYTES
          end
        end
      end
      body
    end

    def validate_result!(result, payload)
      invalid_result! unless result.is_a?(Hash) && result["provider"] == "chronos" &&
        result["model"].is_a?(String) && !result["model"].strip.empty? &&
        result["currency"] == payload[:currency] &&
        result["days"].is_a?(Integer) && result["days"] == payload[:days] &&
        result["history_days"].is_a?(Integer) && result["history_days"] == payload[:history].length &&
        result["balance_as_of"] == payload[:history].last[:date] &&
        result["points"].is_a?(Array) && result["points"].length == payload[:days]

      balance = decimal(payload[:starting_balance])
      invalid_result! unless decimal(result.fetch("starting_balance")) == balance
      anchor = Date.iso8601(result.fetch("balance_as_of"))
      result.fetch("points").each_with_index do |point, index|
        invalid_result! unless point.is_a?(Hash) && point["date"] == (anchor + index + 1).iso8601
        income = decimal(point.fetch("income"))
        expenses = decimal(point.fetch("expenses"))
        net_flow = decimal(point.fetch("net_flow"))
        invalid_result! if income.negative? || expenses.negative? || net_flow != income - expenses
        balance += net_flow
        invalid_result! unless decimal(point.fetch("balance")) == balance
      end
      invalid_result! unless decimal(result.fetch("projected_balance")) == balance
      %w[income_adjustment expense_adjustment].each do |key|
        next unless result.key?(key)
        invalid_result! unless decimal(result[key], cents: false) == decimal(payload.fetch(key.to_sym), cents: false)
      end
      %w[warnings assumptions].each do |key|
        invalid_result! unless result[key].is_a?(Array) && result[key].all? { |item| item.is_a?(String) }
      end
    end

    def decimal(value, cents: true)
      invalid_result! unless value.is_a?(String) || value.is_a?(Numeric)
      result = BigDecimal(value.to_s)
      # Bound exponents before arithmetic as well as the total HTTP body size.
      invalid_result! unless result.finite? && result.exponent.abs <= 30
      invalid_result! if cents && result != result.round(2)
      result
    end

    def invalid_result!
      raise Unavailable, "Chronos-2 service returned an invalid forecast."
    end
  end
end
