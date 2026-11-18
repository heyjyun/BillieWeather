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

  test "nickname is required, trimmed, limited, and used as the display name" do
    @user = FactoryBot.create :onboarded_user, first_name: "Legal", last_name: "Name", nickname: "Billie"
    assert_equal "Billie", @user.name
    @user.update!(nickname: "  Sunny   Day  ")
    assert_equal "Sunny Day", @user.nickname
    assert_equal "Sunny Day", @user.name
    assert_not @user.update(nickname: "   ")
    assert_equal ["blank"], @user.errors.details[:nickname].map { |detail| detail[:error].to_s }
    @user.nickname = "x" * 41
    assert_not @user.valid?
  end

  test "an older account without a nickname uses its email as the display name and is not greeted by it" do
    @user = FactoryBot.create :onboarded_user
    @user.update_column(:nickname, nil)
    assert_equal @user.email, @user.reload.name
    assert_nil @user.preferred_name
  end
end
