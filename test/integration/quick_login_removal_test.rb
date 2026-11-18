require "test_helper"
require "digest"
require "rake"
require_relative "../support/billie_method_stub"

# Regression tests: the development quick-login buttons, the shared Example Account and the
# one-click "personal account" shortcut were removed. Only the standard sign-in paths remain.
class QuickLoginRemovalTest < ActionDispatch::IntegrationTest
  include BillieMethodStub
  include Devise::Test::IntegrationHelpers

  PASSWORD = "Qu1ck!Gone&Standard2026"
  LEGACY_ENV = %w[BILLIE_DEMO_ENABLED BILLIE_PERSONAL_ACCOUNT_EMAIL BILLIE_DEV_PASSWORDLESS_LOGIN].freeze

  setup do
    @user = create(:onboarded_user, nickname: "Billie Owner", email: "owner@example.com",
      password: PASSWORD, password_confirmation: PASSWORD)
    @statement = Finance::Statement.create!(user: @user, filename: "private.csv", currency: "USD",
      sha256: Digest::SHA256.hexdigest("owner"), transaction_count: 1)
    @transaction = Finance::Transaction.create!(user: @user, statement: @statement,
      booked_on: Date.current - 3, description: "PRIVATE OWNER MERCHANT", amount: -42.5, category: "Shopping")
    # The old configuration must have no effect if it is still present on a machine.
    ENV["BILLIE_PERSONAL_ACCOUNT_EMAIL"] = @user.email
    ENV["BILLIE_DEV_PASSWORDLESS_LOGIN"] = "true"
    ENV["BILLIE_DEMO_ENABLED"] = "true"
  end

  teardown do
    LEGACY_ENV.each { |name| ENV.delete(name) }
  end

  test "the sign-in page has no quick-login controls, only the standard options" do
    get new_user_session_path
    assert_response :success

    %w[#quick-login-example #quick-login-personal #quick-login-personal-form .bw-account-choices .bw-account-choice #demo-banner].each do |selector|
      assert_select selector, count: 0
    end
    assert_select "form[action$='/users/demo']", count: 0
    assert_select "form[action*='quick_login']", count: 0
    assert_no_match(/Quick Login|Example Account|Synthetic data/i, response.body)
    assert_not_includes response.body, @user.email
    assert_not_includes response.body, "example@example.com"

    assert_select "h1", "Welcome to BillieWeather"
    assert_select "form[action='#{user_session_path}'] input[name='user[email]']"
    assert_select "form[action='#{user_session_path}'] input[name='user[password]'][required]"
    assert_select "#google-sign-in"
    assert_select "a[href='#{new_user_registration_path}']"
    assert_select "a[href='#{new_user_password_path}']"
  end

  test "the removed shortcut routes no longer exist and sign nobody in" do
    sign_ins = @user.sign_in_count
    assert_not Rails.application.routes.named_routes.key?(:users_demo_session)
    assert_not Rails.application.routes.named_routes.key?(:users_personal_session)

    ["/users/demo", "/users/quick_login/personal"].each do |path|
      post path
      assert_response :not_found
      post path, params: {password: ""}
      assert_response :not_found
    end

    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    assert_equal sign_ins, @user.reload.sign_in_count
  end

  test "the quick-login implementation is gone from the application" do
    %w[DemoAccount PersonalAccount DemoSessionsController PersonalSessionsController QuickLoginCsrf].each do |name|
      assert_not Object.const_defined?(name), "#{name} should no longer exist"
    end
    assert_not User.method_defined?(:demo_account?)

    Rails.application.load_tasks unless Rake::Task.task_defined?("db:migrate")
    %w[billie:demo:seed billie:demo:reset billie:demo:remove].each do |task|
      assert_not Rake::Task.task_defined?(task), "#{task} should no longer exist"
    end
  end

  test "there is no passwordless bypass, even with the old development flags set" do
    sign_ins = @user.sign_in_count
    stub_method(Rails.env, :development?, true) do
      post user_session_path, params: {user: {email: @user.email, password: ""}}
      post user_session_path, params: {user: {email: @user.email, password: "wrong-password"}}
    end

    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    assert_equal sign_ins, @user.reload.sign_in_count
  end

  test "guessable demo credentials cannot authenticate on the website or the app API" do
    # A leftover account at the former demo address, as the old seeder left it: a random password.
    random = SecureRandom.base58(64)
    leftover = create(:onboarded_user, email: "example@example.com", password: random, password_confirmation: random)
    sign_ins = leftover.sign_in_count

    ["", "example", "example-pass", "password", "Example", "example@example.com"].each do |guess|
      post user_session_path, params: {user: {email: leftover.email, password: guess}}
      post "/api/client/v1/session", params: {email: leftover.email, password: guess}, as: :json
      # A blank password is rejected as a malformed request (400); anything else as wrong (401).
      assert_includes [400, 401], response.status
      assert_nil response.parsed_body["token"]
    end
    post "/api/client/v1/session", params: {email: leftover.email}, as: :json
    assert_includes [400, 401], response.status
    assert_nil response.parsed_body["token"]

    get finance_dashboard_path
    assert_redirected_to new_user_session_path
    assert_equal sign_ins, leftover.reload.sign_in_count
  end

  test "standard email and password sign-in still works and keeps the session" do
    post user_session_path, params: {user: {email: @user.email, password: PASSWORD}}
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select ".bw-user-kind", "Personal Account"
    assert_select "#switch-account", "Switch account"

    get finance_transactions_path
    assert_response :success
    assert_match "PRIVATE OWNER MERCHANT", response.body

    delete destroy_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "switch account signs out and returns to the sign-in page" do
    sign_in @user
    delete destroy_user_session_path, params: {switch_account: 1}
    assert_redirected_to new_user_session_path
    get finance_dashboard_path
    assert_redirected_to new_user_session_path
  end

  test "standard registration still works" do
    get new_user_registration_path
    assert_response :success
    assert_difference("User.count", 1) do
      post user_registration_path, params: {user: {nickname: "Alex", email: "new-person@example.com", usage_region: "US",
                                                   password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}}
    end
    assert_redirected_to finance_dashboard_path
  end

  test "password reset still sends instructions for a normal account" do
    assert_difference("ActionMailer::Base.deliveries.length", 1) do
      post user_password_path, params: {user: {email: @user.email}}
    end
    assert_redirected_to new_user_session_path
  end

  test "existing accounts and their financial records are untouched" do
    get new_user_session_path
    post "/users/demo"
    post "/users/quick_login/personal"

    assert User.exists?(@user.id)
    assert_equal 1, @user.finance_statements.count
    assert_equal [@transaction.id], @user.finance_transactions.pluck(:id)
    assert_equal "Shopping", @transaction.reload.category
  end
end
