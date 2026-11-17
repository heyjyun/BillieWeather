require "test_helper"

class FinanceParameterLoggingTest < ActiveSupport::TestCase
  test "financial form and automation payloads are redacted without hiding operational metadata" do
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
    payload = {
      "entry" => {"description" => "Synthetic shop", "note" => "Private medical context", "amount" => "80.00", "tag_names" => "health"},
      "transactions" => [{"original_description" => "Synthetic bank text", "amount" => "30.00"}],
      "merchant" => {"name" => "Synthetic private clinic"},
      "recurring_rule" => {"template" => {"note" => "Private"}},
      "password" => "synthetic-password", "platform" => "macos", "sequence" => 7
    }
    result = filter.filter(payload)
    %w[entry transactions merchant recurring_rule password].each { |key| assert_equal "[FILTERED]", result[key] }
    assert_equal "macos", result["platform"]
    assert_equal 7, result["sequence"]
  end
end
