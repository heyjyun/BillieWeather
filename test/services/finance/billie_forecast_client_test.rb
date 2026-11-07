require "test_helper"

class Finance::BillieForecastClientTest < ActiveSupport::TestCase
  class HttpDouble
    attr_accessor :use_ssl, :open_timeout, :read_timeout, :write_timeout, :max_retries
    attr_reader :requests

    def initialize(body: nil, response_class: Net::HTTPOK, code: "200", error: nil, chunks: nil)
      @body = body
      @response_class = response_class
      @code = code
      @error = error
      @chunks = chunks
      @requests = []
    end

    def request(request)
      @requests << request
      raise @error if @error

      response = @response_class.new("1.1", @code, "Test")
      chunks = @chunks || [@body]
      response.define_singleton_method(:read_body) { |&block| chunks.each(&block) }
      yield response
      response
    end
  end

  setup do
    @history = [
      {date: Date.new(2026, 11, 1), income: BigDecimal(30), expenses: BigDecimal(3)},
      {date: Date.new(2026, 11, 2), income: BigDecimal(0), expenses: BigDecimal(0)},
      {date: Date.new(2026, 11, 3), income: BigDecimal(60), expenses: BigDecimal(6)}
    ]
  end

  test "posts only dated aggregate amounts and validates the returned Chronos balance path" do
    @history.first[:description] = "private merchant description"
    http = HttpDouble.new(body: JSON.generate(valid_result))
    result = with_http(http) do
      client(url: "https://forecast.example.test/api/", api_key: "private-api-key").call(
        history: @history, starting_balance: BigDecimal(100), days: 2
      )
    end

    assert_equal valid_result, result
    assert_equal 1, http.requests.size
    request = http.requests.first
    assert_equal "/api/v1/forecast", request.path
    assert_equal "private-api-key", request["X-API-Key"]
    payload = JSON.parse(request.body)
    assert_equal %w[currency days expense_adjustment history income_adjustment starting_balance], payload.keys.sort
    assert_equal({"date" => "2026-11-01", "income" => "30.0", "expenses" => "3.0"}, payload["history"].first)
    assert_equal "100.0", payload["starting_balance"]
    refute_includes request.body, "private merchant description"
    refute_includes request.body, "private-api-key"
    assert_equal true, http.use_ssl
    assert_equal 3, http.open_timeout
    assert_equal 120, http.read_timeout
    assert_equal 10, http.write_timeout
    assert_equal 0, http.max_retries
  end

  test "an unconfigured API key is omitted and HTTP stays local without TLS" do
    http = HttpDouble.new(body: JSON.generate(valid_result))
    with_http(http) { client.call(history: @history, starting_balance: "100.00", days: 2) }

    assert_nil http.requests.first["X-API-Key"]
    assert_equal false, http.use_ssl
  end

  test "rejects unsupported or credential bearing service URLs before requesting" do
    ["ftp://example.test", "not a URL", "http://user:secret@example.test", "http://example.test/?token=secret", "http://example.test/#secret"].each do |url|
      error = assert_raises(Finance::BillieForecastClient::Unavailable) { client(url: url) }
      refute_includes error.message, "secret"
    end
  end

  test "HTTP failures and redirects are not treated as model results or followed" do
    [[Net::HTTPUnauthorized, "401"], [Net::HTTPServiceUnavailable, "503"], [Net::HTTPFound, "302"]].each do |response_class, code|
      http = HttpDouble.new(body: "private diagnostics and private-api-key", response_class: response_class, code: code)
      error = with_http(http) do
        assert_raises(Finance::BillieForecastClient::Unavailable) do
          client.call(history: @history, starting_balance: "100.00", days: 2)
        end
      end
      assert_equal 1, http.requests.size
      assert_includes error.message, code
      refute_includes error.message, "private"
    end
  end

  test "timeouts and TLS failures return a safe unavailable error without retrying" do
    [Net::ReadTimeout.new("private host details"), OpenSSL::SSL::SSLError.new("private TLS details")].each do |network_error|
      http = HttpDouble.new(error: network_error)
      error = with_http(http) do
        assert_raises(Finance::BillieForecastClient::Unavailable) do
          client.call(history: @history, starting_balance: "100.00", days: 2)
        end
      end
      assert_equal 1, http.requests.size
      refute_includes error.message, "private"
    end
  end

  test "rejects malformed JSON and overlarge streamed bodies" do
    [HttpDouble.new(body: "{private-invalid-json"),
      HttpDouble.new(chunks: [" " * Finance::BillieForecastClient::MAX_RESPONSE_BYTES, "x"])].each do |http|
      error = with_http(http) do
        assert_raises(Finance::BillieForecastClient::Unavailable) do
          client.call(history: @history, starting_balance: "100.00", days: 2)
        end
      end
      refute_includes error.message, "private"
    end
  end

  test "rejects a different provider model metadata dates or scenario echoes" do
    mutations = [
      ->(result) { result["provider"] = "average" },
      ->(result) { result["model"] = nil },
      ->(result) { result["currency"] = "EUR" },
      ->(result) { result["days"] = 3 },
      ->(result) { result["history_days"] = 4 },
      ->(result) { result["balance_as_of"] = "2026-11-02" },
      ->(result) { result["starting_balance"] = "200.00" },
      ->(result) { result["income_adjustment"] = "1" },
      ->(result) { result["points"].pop },
      ->(result) { result["points"].first["date"] = "2026-11-05" }
    ]
    mutations.each { |mutate| assert_invalid_result(mutate) }
  end

  test "rejects nonfinite negative imprecise or inconsistent money" do
    mutations = [
      ->(result) { result["points"].first["income"] = "NaN" },
      ->(result) { result["points"].first["expenses"] = "Infinity" },
      ->(result) { result["points"].first["income"] = "-1.00" },
      ->(result) { result["points"].first["income"] = "30.001" },
      ->(result) { result["points"].first["income"] = "1e999999999" },
      ->(result) { result["points"].first["net_flow"] = "28.00" },
      ->(result) { result["points"].first["balance"] = "128.00" },
      ->(result) { result["projected_balance"] = "155.00" },
      ->(result) { result["warnings"] = "unexpected" }
    ]
    mutations.each { |mutate| assert_invalid_result(mutate) }
  end

  private

  def client(url: "http://127.0.0.1:8000", api_key: nil)
    Finance::BillieForecastClient.new(url: url, api_key: api_key)
  end

  def valid_result
    {"provider" => "chronos", "model" => "amazon/chronos-2", "currency" => "USD",
     "balance_as_of" => "2026-11-03", "starting_balance" => "100.00", "projected_balance" => "154.00",
     "history_days" => 3, "days" => 2, "income_adjustment" => "0", "expense_adjustment" => "0",
     "points" => [
       {"date" => "2026-11-04", "income" => "30.00", "expenses" => "3.00", "net_flow" => "27.00", "balance" => "127.00"},
       {"date" => "2026-11-05", "income" => "30.00", "expenses" => "3.00", "net_flow" => "27.00", "balance" => "154.00"}
     ], "warnings" => [], "assumptions" => ["Daily point estimates."]}
  end

  def with_http(http)
    original = Net::HTTP.method(:new)
    Net::HTTP.define_singleton_method(:new) { |*| http }
    yield
  ensure
    Net::HTTP.define_singleton_method(:new, original)
  end

  def assert_invalid_result(mutate)
    result = valid_result
    mutate.call(result)
    http = HttpDouble.new(body: JSON.generate(result))
    with_http(http) do
      assert_raises(Finance::BillieForecastClient::Unavailable) do
        client.call(history: @history, starting_balance: "100.00", days: 2)
      end
    end
  end
end
