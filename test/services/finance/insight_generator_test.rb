require "test_helper"
require "stringio"
require_relative "../../support/billie_method_stub"

class Finance::InsightGeneratorTest < ActiveSupport::TestCase
  test "aggregate decimal formatting preserves cents beyond float precision" do
    generator = Finance::InsightGenerator.new(user: create(:user))
    assert_equal "12345678901234567.89", generator.send(:decimal_string, BigDecimal("12345678901234567.89"))
  end
  include BillieMethodStub

  class SnapshotDouble
    def initialize(data)
      @data = data
    end

    def to_h
      @data
    end
  end

  class HttpDouble
    attr_accessor :use_ssl, :open_timeout, :read_timeout, :write_timeout, :max_retries
    attr_reader :requests

    def initialize(response: nil, error: nil)
      @response = response
      @error = error
      @requests = []
    end

    def request(request)
      @requests << request
      raise @error if @error
      @response
    end
  end

  setup do
    @user = create(:onboarded_user)
    @profile = Finance::Profile.create!(user: @user, currency: "USD", tax_country: nil, tax_profile: nil)
    @snapshot = {
      currency: "USD", income: BigDecimal("1000.25"), expenses: BigDecimal("350.10"),
      net: BigDecimal("650.15"), transaction_count: 8, uncategorized_count: 2, tax_review_count: 1, excluded_count: 0, transfer_count: 0,
      period_start: Date.new(2026, 10, 1), period_end: Date.new(2026, 10, 31),
      categories: [{name: "Housing", amount: BigDecimal("300.00")}, {name: "Food & dining", amount: BigDecimal("50.10")}],
      monthly: [{month: Date.new(2026, 10, 1), income: BigDecimal("1000.25"), expenses: BigDecimal("350.10"), net: BigDecimal("650.15")}]
    }
  end

  test "basic analysis saves exact imported totals and flags missing tax context without calling AI" do
    with_snapshot do
      stub_method(Net::HTTP, :new, ->(*) { flunk "Basic analysis must not contact an AI service" }) do
        assert_difference("Finance::Insight.count", 1) do
          insight = Finance::InsightGenerator.new(user: @user).call
          assert_equal @user.id, insight.user_id
          assert_equal "rules", insight.source
          assert_includes insight.content.fetch("summary"), "USD 650.15"
          assert_includes insight.content.fetch("summary"), "not your account balance"
          assert insight.content.fetch("actions").any? { |entry| entry.fetch("body").include?("Uncategorized included transactions: 2") }
          assert insight.content.fetch("tax_preparation").any? { |entry| entry.fetch("title") == "Choose your tax context" }
          assert insight.content.fetch("tax_preparation").any? { |entry| entry.fetch("body").include?("Transactions marked for tax review: 1") }
          assert insight.generated_at.present?
        end
      end
    end
  end

  test "basic analysis handles an empty account without claiming income or tax deductions" do
    @snapshot.merge!(income: 0.to_d, expenses: 0.to_d, net: 0.to_d, transaction_count: 0, uncategorized_count: 0, tax_review_count: 0, categories: [], monthly: [], period_start: nil, period_end: nil)
    with_snapshot do
      insight = Finance::InsightGenerator.new(user: @user).call
      assert_includes insight.content.fetch("summary"), "Upload a statement"
      assert insight.content.fetch("tax_preparation").any? { |entry| entry.fetch("body").include?("does not establish tax treatment") }
    end
  end

  test "basic tax context comes only from the current account" do
    other_user = create(:onboarded_user)
    Finance::Profile.create!(user: other_user, currency: "USD", tax_country: "OTHER USER PRIVATE COUNTRY", tax_profile: "business")
    @profile.update!(tax_country: "Canada", tax_profile: "self_employed")

    with_snapshot do
      insight = Finance::InsightGenerator.new(user: @user).call
      text = insight.content.to_json
      assert_includes text, "Canada / self employed"
      refute_includes text, "OTHER USER PRIVATE COUNTRY"
      refute insight.content.fetch("tax_preparation").any? { |entry| entry.fetch("title") == "Choose your tax context" }
    end
  end

  test "all-excluded activity does not claim a usable cash surplus" do
    @snapshot.merge!(income: 0.to_d, expenses: 0.to_d, net: 0.to_d, uncategorized_count: 0, excluded_count: 8, categories: [], monthly: [], period_start: nil, period_end: nil)
    with_snapshot do
      insight = Finance::InsightGenerator.new(user: @user).call
      assert_includes insight.content.fetch("summary"), "none are currently included"
      assert insight.content.fetch("actions").any? { |entry| entry.fetch("title") == "Check transaction inclusion" }
      refute insight.content.fetch("actions").any? { |entry| entry.fetch("title") == "Give your cash flow a plan" }
    end
  end

  test "US personal preparation uses an applicable-record checklist and does not treat bank credits as tax income" do
    @profile.update!(tax_country: "United States", tax_profile: "personal")
    with_snapshot do
      insight = Finance::InsightGenerator.new(user: @user).call
      tasks = insight.content.fetch("tax_preparation").map { |item| item.fetch("body") }.join(" ")
      %w[W-2 1099 1098 1095-A].each { |form| assert_includes tasks, form }
      assert_includes tasks, "prior-year return"
      assert_includes tasks, "not automatically taxable income"
      assert_includes tasks, "do not replace W-2 wages"
      assert_includes tasks, "not a completed return"
      refute tasks.include?("Prepare questions for your tax professional")
    end
  end

  test "AI analysis requires explicit consent before any HTTP request" do
    with_ai_configuration do
      stub_method(Net::HTTP, :new, ->(*) { flunk "No consent must mean no external request" }) do
        assert_no_difference("Finance::Insight.count") do
          error = assert_raises(Finance::InsightGenerator::Error) do
            Finance::InsightGenerator.new(user: @user, provider: "openai", consent: false).call
          end
          assert_includes error.message, "consent"
        end
      end
    end
  end

  test "AI analysis sends only aggregate data with no response storage and saves validated content" do
    http = HttpDouble.new(response: success_response(valid_content))
    connections = []
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, ->(host, port) {
          connections << [host, port]
          http
        }) do
          insight = Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
          assert_equal "openai", insight.source
          assert_equal valid_content, insight.content
        end
      end
    end

    assert_equal 1, http.requests.length
    assert_equal [["api.openai.com", 443]], connections
    request = http.requests.first
    assert_equal "/v1/responses", request.path
    assert_equal "Bearer test-secret-never-log", request["Authorization"]
    payload = JSON.parse(request.body)
    assert_equal "test-configured-model", payload.fetch("model")
    refute payload.key?("reasoning")
    assert_equal false, payload.fetch("store")
    assert_equal true, payload.dig("text", "format", "strict")
    assert_equal "json_schema", payload.dig("text", "format", "type")
    data = JSON.parse(payload.fetch("input").first.fetch("content"))
    assert_equal "650.15", data.fetch("net")
    assert_equal 8, data.fetch("transaction_count")
    assert_equal "2026-10-01", data.fetch("period_start")
    assert_equal %w[categories currency excluded_count expenses income monthly net period_end period_start tax_country tax_profile tax_review_count transaction_count transfer_count uncategorized_count], data.keys.sort
    refute_includes request.body, @user.email
    refute_includes request.body, "test-secret-never-log"
    assert_equal true, http.use_ssl
    assert_equal 0, http.max_retries
  end

  test "encrypted AI credentials take precedence over environment settings" do
    credentials = {openai: {api_key: " credential-secret-never-log ", model: " credential-model ", reasoning_effort: " high "}}

    with_ai_configuration(key: "environment-secret-never-log", model: "environment-model",
      reasoning_effort: "low", credentials: credentials) do
      assert_equal "credential-secret-never-log", Finance::InsightGenerator.api_key
      assert_equal "credential-model", Finance::InsightGenerator.model
      assert_equal "high", Finance::InsightGenerator.reasoning_effort
    end
  end

  test "missing encrypted AI settings fall back to environment settings" do
    credentials = {openai: {api_key: " ", model: nil, reasoning_effort: ""}}

    with_ai_configuration(reasoning_effort: "medium", credentials: credentials) do
      assert_equal "test-secret-never-log", Finance::InsightGenerator.api_key
      assert_equal "test-configured-model", Finance::InsightGenerator.model
      assert_equal "medium", Finance::InsightGenerator.reasoning_effort
    end
  end

  test "AI requests always go directly to the official OpenAI API" do
    with_ai_configuration do
      assert_equal URI("https://api.openai.com/v1/responses"), Finance::InsightGenerator.endpoint
      assert_equal "OpenAI", Finance::InsightGenerator.ai_service_name
    end
  end

  test "a failed OpenAI request does not retry" do
    response = http_response(Net::HTTPServiceUnavailable, "503", "Service Unavailable",
      '{"error":{"message":"private provider diagnostic test-secret-never-log"}}')
    http = HttpDouble.new(response: response)
    connections = []
    log = StringIO.new

    with_ai_configuration do
      with_snapshot do
        stub_method(Rails, :logger, ActiveSupport::Logger.new(log)) do
          stub_method(Net::HTTP, :new, ->(host, port) {
            connections << [host, port]
            http
          }) do
            assert_no_difference("Finance::Insight.count") do
              error = assert_raises(Finance::InsightGenerator::Error) do
                Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
              end
              refute_includes error.message, "test-secret-never-log"
              refute_includes error.message, "private provider diagnostic"
            end
          end
        end
      end
    end

    assert_equal [["api.openai.com", 443]], connections
    assert_equal 1, http.requests.length
    assert_equal 0, http.max_retries
    refute_includes log.string, "test-secret-never-log"
    refute_includes log.string, "private provider diagnostic"
  end

  test "quota exhaustion fails with a clear OpenAI message and saves nothing" do
    response = http_response(Net::HTTPTooManyRequests, "429", "Too Many Requests", JSON.generate(error: {code: "insufficient_quota"}))
    http = HttpDouble.new(response: response)
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            error = assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
            end
            assert_includes error.message, "OpenAI"
          end
        end
      end
    end
    assert_equal 1, http.requests.length
  end

  test "HTTP errors produce a safe message without persisting fake AI output" do
    response = http_response(Net::HTTPUnauthorized, "401", "Unauthorized", '{"error":{"message":"private provider diagnostic test-secret-never-log"}}')
    http = HttpDouble.new(response: response)
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            error = assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
            end
            assert_includes error.message, "Check its API key"
            refute_includes error.message, "test-secret-never-log"
            refute_includes error.message, "private provider diagnostic"
          end
        end
      end
    end
  end

  test "network timeout is safe and does not retry or save an insight" do
    http = HttpDouble.new(error: Net::ReadTimeout.new("private network details"))
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            error = assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
            end
            assert_includes error.message, "temporarily unavailable"
            refute_includes error.message, "private network details"
          end
        end
      end
    end
    assert_equal 1, http.requests.length
  end

  test "invalid structured output is rejected rather than shown as AI analysis" do
    http = HttpDouble.new(response: success_response(valid_content.merge("actions" => [{"title" => "Missing body"}])))
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
            end
          end
        end
      end
    end
  end

  test "incomplete or refused output is not persisted" do
    response = http_response(Net::HTTPOK, "200", "OK", JSON.generate(status: "incomplete", output: []))
    http = HttpDouble.new(response: response)
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true).call
            end
          end
        end
      end
    end
  end

  test "AI availability requires both a key and an explicitly configured model" do
    with_ai_configuration(model: "") { refute Finance::InsightGenerator.ai_available? }
    with_ai_configuration(key: "") { refute Finance::InsightGenerator.ai_available? }
    with_ai_configuration { assert Finance::InsightGenerator.ai_available? }
  end

  private

  test "Billie tax preparation insights are AI-only and never call the service without AI provider" do
    stub_method(Net::HTTP, :new, ->(*) { flunk "Rules provider must never contact an AI service" }) do
      assert_no_difference("Finance::Insight.count") do
        error = assert_raises(Finance::InsightGenerator::Error) do
          Finance::InsightGenerator.new(user: @user, provider: "rules", kind: "tax").call
        end
        assert_includes error.message, "AI service"
      end
    end
  end

  test "Billie tax preparation insights require explicit consent before any HTTP request" do
    with_ai_configuration do
      stub_method(Net::HTTP, :new, ->(*) { flunk "No consent must mean no external request" }) do
        assert_no_difference("Finance::Insight.count") do
          error = assert_raises(Finance::InsightGenerator::Error) do
            Finance::InsightGenerator.new(user: @user, provider: "openai", consent: false, kind: "tax").call
          end
          assert_includes error.message, "consent"
        end
      end
    end
  end

  test "Billie tax preparation insights use the tax schema, stay aggregate-only, and save as kind tax" do
    http = HttpDouble.new(response: success_response(valid_tax_content))
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          insight = Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true, kind: "tax").call
          assert_equal "tax", insight.kind
          assert_equal "openai", insight.source
          assert_equal valid_tax_content, insight.content
        end
      end
    end

    payload = JSON.parse(http.requests.first.body)
    assert_equal "billie_tax_preparation", payload.dig("text", "format", "name")
    assert_equal %w[limitations questions summary tax_preparation], payload.dig("text", "format", "schema", "required").sort
    assert_includes payload.fetch("instructions"), "You are Billie"
    assert_equal false, payload.fetch("store")
    refute_includes http.requests.first.body, @user.email
    assert_equal 0, Finance::Insight.general.count
    assert_equal 1, Finance::Insight.tax.count
  end

  test "Billie tax preparation output with general sections is rejected" do
    http = HttpDouble.new(response: success_response(valid_content))
    with_ai_configuration do
      with_snapshot do
        stub_method(Net::HTTP, :new, http) do
          assert_no_difference("Finance::Insight.count") do
            error = assert_raises(Finance::InsightGenerator::Error) do
              Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true, kind: "tax").call
            end
            assert_includes error.message, "invalid"
            refute_includes error.message, "basic analysis"
          end
        end
      end
    end
  end

  test "unknown insight kinds are rejected" do
    assert_raises(Finance::InsightGenerator::Error) { Finance::InsightGenerator.new(user: @user, kind: "bogus").call }
  end

  def valid_tax_content
    {
      "summary" => "Billie reviewed your imported totals and prepared a record checklist.",
      "tax_preparation" => [{"title" => "Gather income documents", "body" => "Collect the income forms that apply to you and match them to your statements."}],
      "questions" => [{"title" => "Which records matter?", "body" => "Ask your tax professional which of these records they need for your situation."}],
      "limitations" => ["No tax calculation or filing is performed."]
    }
  end

  def with_snapshot(&block)
    stub_method(Finance::Snapshot, :new, SnapshotDouble.new(@snapshot), &block)
  end

  def with_ai_configuration(key: "test-secret-never-log", model: "test-configured-model", reasoning_effort: nil, credentials: {})
    settings = {"OPENAI_API_KEY" => key, "OPENAI_MODEL" => model, "OPENAI_REASONING_EFFORT" => reasoning_effort}
    previous = settings.keys.to_h { |name| [name, ENV[name]] }
    settings.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value.to_s }
    stub_method(Rails.application, :credentials, credentials) { yield }
  ensure
    previous.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end

  def valid_content
    {
      "summary" => "Imported income exceeds spending within this sample.",
      "observations" => [{"title" => "Positive imported cash flow", "body" => "The imported net flow is USD 650.15; this is not a verified balance."}],
      "actions" => [{"title" => "Review coverage", "body" => "Confirm all relevant statements are included."}],
      "tax_preparation" => [{"title" => "Keep supporting records", "body" => "Organize statements and receipts for review with your tax preparer."}],
      "limitations" => ["No tax calculation or filing is performed."]
    }
  end

  def success_response(content)
    body = JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: JSON.generate(content)}]}])
    http_response(Net::HTTPOK, "200", "OK", body)
  end

  def http_response(response_class, code, message, body)
    response = response_class.new("1.1", code, message)
    response.define_singleton_method(:body) { body }
    response
  end
end
