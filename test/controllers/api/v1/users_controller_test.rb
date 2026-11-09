require "controllers/api/v1/test"

class Api::V1::UsersControllerTest < Api::Test
  setup do
    # See `test/controllers/api/test.rb` for common set up for API tests.

    @users = create_list(:user, 3)
    # 🚅 super scaffolding will insert file-related logic above this line.
    @user.save

    @another_user = create(:user)
  end

  # This assertion is written in such a way that new attributes won't cause the tests to start failing, but removing
  # data we were previously providing to users _will_ break the test suite.
  def assert_proper_object_serialization(user_data)
    # Fetch the user in question and prepare to compare it's attributes.
    user = User.find(user_data["id"])

    assert_equal_or_nil user_data["first_name"], user.first_name
    assert_equal_or_nil user_data["last_name"], user.last_name
    assert_equal_or_nil user_data["time_zone"], user.time_zone
    assert_equal_or_nil user_data["locale"], user.locale
    # 🚅 super scaffolding will insert new fields above this line.
  end

  test "index" do
    # Fetch and ensure nothing is seriously broken.
    get "/api/v1/users", params: {access_token: access_token}
    assert_response :success

    # Make sure it's returning our resources.
    user_ids_returned = response.parsed_body.map { |user| user["id"] }
    assert_includes(user_ids_returned, @user.id)

    # But not returning other people's resources.
    assert_not_includes(user_ids_returned, @another_user.id)

    # And that the object structure is correct.
    assert_proper_object_serialization response.parsed_body.first
  end

  test "show" do
    # Fetch and ensure nothing is seriously broken.
    get "/api/v1/users/#{@user.id}", params: {access_token: access_token}
    assert_response :success

    # Ensure all the required data is returned properly.
    assert_proper_object_serialization response.parsed_body

    # Also ensure we can't do that same action as another user.
    get "/api/v1/users/#{@user.id}", params: {access_token: another_access_token}
    assert_response :not_found
  end

  test "legacy users must select a region before using the API" do
    @user.update_columns(usage_region: nil, usage_region_pending: true)
    get "/api/v1/users/#{@user.id}", params: {access_token: access_token}
    assert_response :unprocessable_entity
    assert_equal "usage_region_required", response.parsed_body.fetch("error")
    assert_equal finance_settings_path, response.parsed_body.fetch("settings_path")

    @user.reload.update!(usage_region: "CN")
    get "/api/v1/users/#{@user.id}", params: {access_token: access_token}
    assert_response :success
    assert_equal "CN", response.parsed_body.fetch("usage_region")
  end
end
