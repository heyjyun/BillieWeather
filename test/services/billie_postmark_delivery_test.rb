require "test_helper"
require_relative "../support/billie_method_stub"

class BilliePostmarkDeliveryTest < ActiveSupport::TestCase
  include BillieMethodStub

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

  test "registered Action Mailer adapter supports the production delivery method" do
    assert_equal BilliePostmarkDelivery, ActionMailer::Base.delivery_methods.fetch(:postmark)
  end

  test "multipart account email is sent over HTTPS using the verified sender and no link tracking" do
    mail = Mail.new do
      from "Placeholder <placeholder@localhost>"
      to "Reader <reader@example.com>"
      cc "copy@example.com"
      reply_to "help@example.com"
      subject "Reset your password"
      text_part { body "Reset your password: https://example.com/reset?token=private-reset-token" }
      html_part do
        content_type "text/html; charset=UTF-8"
        body '<a href="https://example.com/reset?token=private-reset-token">Reset password</a>'
      end
    end
    http = HttpDouble.new(response: response_for(Net::HTTPOK, "200", {"ErrorCode" => 0, "MessageID" => "accepted-message"}))

    stub_method(Net::HTTP, :new, http) { assert_same mail, adapter.deliver!(mail) }

    assert_equal 1, http.requests.length
    request = http.requests.first
    assert_equal "/email", request.path
    assert_equal "test-postmark-token", request["X-Postmark-Server-Token"]
    assert_equal "application/json", request["Accept"]
    payload = JSON.parse(request.body)
    assert_equal "BillieWeather <verified@example.com>", payload.fetch("From")
    assert_equal "Reader <reader@example.com>", payload.fetch("To")
    assert_equal "copy@example.com", payload.fetch("Cc")
    assert_equal "help@example.com", payload.fetch("ReplyTo")
    assert_equal "outbound", payload.fetch("MessageStream")
    assert_equal false, payload.fetch("TrackOpens")
    assert_equal "None", payload.fetch("TrackLinks")
    assert_includes payload.fetch("TextBody"), "private-reset-token"
    assert_includes payload.fetch("HtmlBody"), "private-reset-token"
    refute_includes request.body, "test-postmark-token"
    assert_equal true, http.use_ssl
    assert_equal 0, http.max_retries
  end

  test "plain-text email and attachment use the expected Postmark fields" do
    mail = Mail.new(from: "placeholder@localhost", to: "reader@example.com", subject: "Your records", body: "Keep your records.")
    mail.attachments["records.txt"] = "example attachment"
    http = HttpDouble.new(response: response_for(Net::HTTPOK, "200", {"ErrorCode" => 0, "MessageID" => "accepted-message"}))

    stub_method(Net::HTTP, :new, http) { adapter.deliver!(mail) }

    payload = JSON.parse(http.requests.first.body)
    assert_equal "Keep your records.", payload.fetch("TextBody")
    attachment = payload.fetch("Attachments").first
    assert_equal "records.txt", attachment.fetch("Name")
    assert_equal "example attachment", Base64.strict_decode64(attachment.fetch("Content"))
  end

  test "missing credentials fail before sending any email" do
    mail = Mail.new(to: "reader@example.com", body: "Hello")
    stub_method(Net::HTTP, :new, ->(*) { flunk "Unconfigured email must not reach the provider" }) do
      error = assert_raises(BilliePostmarkDelivery::Error) { BilliePostmarkDelivery.new(api_token: "").deliver!(mail) }
      assert_includes error.message, "not configured"
    end
  end

  test "provider rejection does not expose response text or retry delivery" do
    http = HttpDouble.new(response: response_for(Net::HTTPUnprocessableEntity, "422", {"ErrorCode" => 300, "Message" => "private-provider-data test-postmark-token"}))
    stub_method(Net::HTTP, :new, http) do
      error = assert_raises(BilliePostmarkDelivery::Error) { adapter.deliver!(simple_mail) }
      assert_includes error.message, "could not deliver"
      refute_includes error.message, "private-provider-data"
      refute_includes error.message, "test-postmark-token"
    end
    assert_equal 1, http.requests.length
  end

  test "network timeout returns a safe delivery error without retry" do
    http = HttpDouble.new(error: Net::ReadTimeout.new("private delivery detail"))
    stub_method(Net::HTTP, :new, http) do
      error = assert_raises(BilliePostmarkDelivery::Error) { adapter.deliver!(simple_mail) }
      assert_includes error.message, "temporarily unavailable"
      refute_includes error.message, "private delivery detail"
    end
    assert_equal 1, http.requests.length
  end

  test "HTTP success without a confirmed Postmark message fails safely" do
    http = HttpDouble.new(response: response_for(Net::HTTPOK, "200", {"ErrorCode" => 406, "Message" => "private recipient data"}))
    stub_method(Net::HTTP, :new, http) do
      error = assert_raises(BilliePostmarkDelivery::Error) { adapter.deliver!(simple_mail) }
      assert_includes error.message, "could not confirm"
      refute_includes error.message, "private recipient data"
    end
  end

  private

  def adapter
    BilliePostmarkDelivery.new(api_token: "test-postmark-token", from: "BillieWeather <verified@example.com>")
  end

  def simple_mail
    Mail.new(to: "reader@example.com", body: "Hello")
  end

  def response_for(response_class, code, content)
    response = response_class.new("1.1", code, "Test response")
    body = JSON.generate(content)
    response.define_singleton_method(:body) { body }
    response
  end
end
