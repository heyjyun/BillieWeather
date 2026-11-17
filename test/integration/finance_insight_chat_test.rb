require "test_helper"
require_relative "../support/billie_method_stub"

class FinanceInsightChatTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  class HttpDouble
    attr_accessor :use_ssl, :open_timeout, :read_timeout, :write_timeout, :max_retries
    attr_reader :requests

    def initialize(response)
      @response = response
      @requests = []
    end

    def request(request)
      @requests << request
      @response
    end
  end

  setup do
    @user = create(:onboarded_user)
  end

  test "chat requires sign in" do
    post chat_finance_insights_path, params: {consent: "1", messages: [{role: "user", content: "Hi"}]}, as: :json
    assert_response :unauthorized
  end

  test "insights page shows the chat box when AI is configured and a notice otherwise" do
    sign_in @user
    with_ai(key: nil) do
      get finance_insights_path
      assert_response :success
      assert_select "#ask-billie"
      assert_select "[data-insight-chat]", count: 0
    end
    with_ai do
      get finance_insights_path
      assert_select "[data-insight-chat] textarea[data-chat-input]"
      assert_select "[data-insight-chat] [data-chat-consent]"
      assert_select "[data-chat-suggestion]", minimum: 1
    end
  end

  test "chat returns the AI answer as JSON" do
    sign_in @user
    body = JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: "Housing was your largest category."}]}])
    response = Net::HTTPOK.new("1.1", "200", "OK")
    response.define_singleton_method(:body) { body }
    http = HttpDouble.new(response)
    with_ai do
      stub_method(Net::HTTP, :new, http) do
        post chat_finance_insights_path, params: {consent: "1", messages: [{role: "user", content: "What did I spend most on?"}]}, as: :json
      end
    end
    assert_response :success
    assert_equal "Housing was your largest category.", response_json["answer"]
    assert_equal 1, http.requests.length
  end

  test "chat without consent is rejected without contacting the AI" do
    sign_in @user
    with_ai do
      stub_method(Net::HTTP, :new, ->(*) { flunk "No consent must mean no external request" }) do
        post chat_finance_insights_path, params: {messages: [{role: "user", content: "Hi"}]}, as: :json
      end
    end
    assert_response :unprocessable_entity
    assert_equal I18n.t("billie.insight_chat.errors.consent_required"), response_json["error"]
  end

  private

  def response_json = JSON.parse(@response.body)

  def with_ai(key: "test-key", &block)
    settings = {"OPENAI_API_KEY" => key, "OPENAI_MODEL" => "test-model", "OPENAI_REASONING_EFFORT" => nil}
    previous = settings.keys.to_h { |name| [name, ENV[name]] }
    settings.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value.to_s }
    stub_method(Rails.application, :credentials, {}, &block)
  ensure
    previous.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end
end
