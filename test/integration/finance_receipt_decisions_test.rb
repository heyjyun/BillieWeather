require "test_helper"
require "stringio"

# Match decisions on the website call exactly one of the reconciler's four decision methods, chosen from
# an explicit list (Finance::ReceiptsController::DECISIONS), never a method named by the request (C-06).
class FinanceReceiptDecisionsTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieModules::SignInWithAllModules

  LINES = ["WHOLE FOODS MARKET", "2525 Lamar Blvd", "Austin, TX 78705", "11/16/2026 6:42 PM", "ORGANIC BANANAS 1.98", "SUBTOTAL 44.94", "TAX 3.66",
    "TOTAL 48.60", "VISA **** 4821 48.60", "TRANS# 004512"].freeze

  setup do
    @user = create(:onboarded_user, usage_region: "US")
    Finance::Profile.find_or_create_by!(user_id: @user.id) { |profile| profile.currency = "USD" }
    Finance::Profile.where(user_id: @user.id).update_all(currency: "USD")
    sign_in @user
  end

  # A recorded receipt and a later bank row on another day: one suggested (probable) match.
  def suggested_match
    receipt = Finance::ReceiptIngestion.call(user: @user, source: "app", lines: LINES.map { |text| {text: text, confidence: 0.95} }).receipt
    Finance::ReceiptReconciler.new(@user).record!(receipt)
    stream = StringIO.new("Date,Description,Amount\n2026-11-21,WHOLEFDS MKT,-48.60\n")
    stream.define_singleton_method(:original_filename) { "bank.csv" }
    Finance::StatementImporter.new(user: @user, file: stream, currency: "USD").call
    receipt.reload.matches.sole
  end

  test "the decision list is exactly what the route allows, and each entry is a reconciler decision" do
    route = Rails.application.routes.routes.find { |candidate| candidate.name == "finance_receipt_match_decision" }
    assert route, "the decision route exists"
    allowed = Finance::ReceiptsController::DECISIONS.keys
    allowed.each { |decision| assert_match route.requirements[:decision], decision }
    %w[process record! dismiss mark_duplicate link_manually update_fields instance_eval].each do |other|
      refute_match(/\A(?:#{route.requirements[:decision].source})\z/, other)
      refute_includes allowed, other
    end
    assert_equal %i[confirm reject undo reconsider], Finance::ReceiptsController::DECISIONS.values
    Finance::ReceiptsController::DECISIONS.each_value { |method| assert Finance::ReceiptReconciler.public_method_defined?(method), method }
  end

  test "confirm and undo go through the reconciler" do
    match = suggested_match
    assert_equal "suggested", match.status
    patch finance_receipt_match_decision_path(match, "confirm")
    assert_redirected_to finance_receipt_path(match.receipt_id)
    assert_equal "confirmed", match.reload.status
    patch finance_receipt_match_decision_path(match, "undo")
    assert_redirected_to finance_receipt_path(match.receipt_id)
    refute_equal "confirmed", match.reload.status
  end

  test "a decision outside the list is not routed and changes nothing" do
    match = suggested_match
    patch "/app/receipts/matches/#{match.id}/process"
    assert_response :not_found
    assert_equal "suggested", match.reload.status
  end

  test "another person's match is not found" do
    match = suggested_match
    other = create(:onboarded_user, usage_region: "US")
    sign_in other
    patch finance_receipt_match_decision_path(match, "confirm")
    assert_response :not_found
    assert_equal "suggested", match.reload.status
  end
end
