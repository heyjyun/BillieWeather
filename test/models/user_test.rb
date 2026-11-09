require "test_helper"

class UserTest < ActiveSupport::TestCase
  setup do
    @user = User.new(email: "jane@bullettrain.co")
  end

  test "details are complete without a first or last name" do
    @user = FactoryBot.create :onboarded_user, first_name: nil, last_name: nil
    assert @user.details_provided?
    assert_equal @user.email, @user.formatted_email_address
  end

  test "nickname is optional, trimmed, limited, and used as the display name" do
    @user = FactoryBot.create :onboarded_user, first_name: "Legal", last_name: "Name"
    assert_equal @user.email, @user.name
    @user.update!(nickname: "  Sunny   Day  ")
    assert_equal "Sunny Day", @user.nickname
    assert_equal "Sunny Day", @user.name
    @user.update!(nickname: "   ")
    assert_nil @user.nickname
    @user.nickname = "x" * 41
    assert_not @user.valid?
  end
end
