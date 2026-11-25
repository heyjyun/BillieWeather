require "test_helper"

# The test environment's cache is a NullStore, so `rate_limit` never counts anything in the other tests
# (C-08). Here the store the limits were declared with counts in a real MemoryStore, as Redis does in
# production.
class ClientApi::V1::RateLimitsTest < ActionDispatch::IntegrationTest
  def with_counting_store
    # rate_limit captures the controller's cache_store when the class is loaded; count in a real store there.
    store = ClientApi::V1::BaseController.cache_store
    memory = ActiveSupport::Cache::MemoryStore.new
    store.define_singleton_method(:increment) { |*args, **options| memory.increment(*args, **options) }
    yield
  ensure
    store.singleton_class.send(:remove_method, :increment)
  end

  def sign_in_attempt(ip)
    post "/api/client/v1/session", params: {email: "nobody@example.com", password: "wrong"}, as: :json, env: {"REMOTE_ADDR" => ip}
    response.status
  end

  test "the limits use the same store as every client API controller" do
    [ClientApi::V1::SessionsController, ClientApi::V1::FinanceController, ClientApi::V1::ReceiptsController].each do |controller|
      assert_same ClientApi::V1::BaseController.cache_store, controller.cache_store, controller.name
    end
  end

  test "sign-in allows 10 attempts per minute and address, then answers 429; another address is unaffected" do
    with_counting_store do
      assert_equal [401] * 10, Array.new(10) { sign_in_attempt("198.51.100.7") }
      assert_equal 429, sign_in_attempt("198.51.100.7")
      assert_equal({"error" => "rate_limited"}, response.parsed_body)
      assert_equal 401, sign_in_attempt("198.51.100.8")
      travel 61.seconds do
        assert_equal 401, sign_in_attempt("198.51.100.7")
      end
    end
  end

  test "signed-in finance requests are limited to 60 per minute and address" do
    user = create(:onboarded_user, usage_region: "US")
    token, = ClientApi::SessionToken.issue(user)
    with_counting_store do
      statuses = Array.new(61) do
        get "/api/client/v1/finance/rules", headers: {"Authorization" => "Bearer #{token}"}, env: {"REMOTE_ADDR" => "198.51.100.9"}
        response.status
      end
      assert_equal [200] * 60, statuses.first(60)
      assert_equal 429, statuses.last
    end
  end

  test "without a counting store nothing is limited (why the other tests never see 429)" do
    assert_equal [401] * 12, Array.new(12) { sign_in_attempt("198.51.100.10") }
  end
end
