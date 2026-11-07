require "test_helper"
require_relative "../support/billie_method_stub"

class PasswordsControllerTest < ActionDispatch::IntegrationTest
  include BillieMethodStub

  test "production recovery GET and POST are unavailable without a provider and never claim delivery" do
    with_mail_settings(token: nil, sender: nil) do
      stub_method(Rails.env, :production?, true) do
        stub_method(Net::HTTP, :new, ->(*) { flunk "Unconfigured recovery must not contact an email service" }) do
          get new_user_password_path
          assert_redirected_to new_user_session_path
          assert_includes flash[:alert], "temporarily unavailable"

          assert_no_difference("ActionMailer::Base.deliveries.length") do
            post user_password_path, params: {user: {email: "reader@example.com"}}
          end
          assert_redirected_to new_user_session_path
          assert_includes flash[:alert], "temporarily unavailable"
        end
      end
    end
  end

  test "a token without a verified sender cannot enable production recovery" do
    with_mail_settings(token: "configured-token", sender: nil) do
      stub_method(Rails.env, :production?, true) do
        post user_password_path, params: {user: {email: "reader@example.com"}}
        assert_redirected_to new_user_session_path
        assert_includes flash[:alert], "temporarily unavailable"
      end
    end
  end

  test "provider failures show a generic recovery message without exposing provider details" do
    with_mail_settings(token: "configured-token", sender: "verified@example.com") do
      stub_method(Rails.env, :production?, true) do
        stub_method(User, :send_reset_password_instructions, ->(*) { raise BilliePostmarkDelivery::Error, "private-provider-details configured-token" }) do
          post user_password_path, params: {user: {email: "reader@example.com"}}
          assert_redirected_to new_user_session_path
          assert_includes flash[:alert], "temporarily unavailable"
          refute_includes flash[:alert], "private-provider-details"
          refute_includes flash[:alert], "configured-token"
        end
      end
    end
  end

  test "recovery page renders an accessible email form in local development" do
    get new_user_password_path
    assert_response :success
    assert_select "form[action=?]", user_password_path do
      assert_select 'input[type="email"][name="user[email]"]'
      assert_select 'input[type="submit"][value="Send reset link"]'
    end
  end

  private

  def with_mail_settings(token:, sender:)
    original = ENV.values_at("POSTMARK_API_TOKEN", "MAIL_FROM")
    token.nil? ? ENV.delete("POSTMARK_API_TOKEN") : ENV["POSTMARK_API_TOKEN"] = token
    sender.nil? ? ENV.delete("MAIL_FROM") : ENV["MAIL_FROM"] = sender
    yield
  ensure
    %w[POSTMARK_API_TOKEN MAIL_FROM].zip(original).each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end
end
