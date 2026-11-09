require "test_helper"
require "tempfile"
require_relative "../support/billie_method_stub"

# The Categories page: custom categories, category details, and "Categorize with AI"
# (website and the apps' API).
class FinanceCategoriesTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include BillieMethodStub

  PASSWORD = "a-long-test-password-1"
  CSV_TEXT = <<~CSV
    Date,Description,Amount
    2026-01-03,ZORBLAX PET SUPPLY #4421 CARD 4111111111111111,-42.10
    2026-01-09,Zorblax Pet Supply 77,-12.00
    2026-01-12,QWERTY STUDIO 555-123-4567,-80.00
    2026-01-15,STARBUCKS STORE 1234,-5.25
    2026-01-20,MYSTERY DEPOSIT REF 99812,300.00
  CSV

  setup do
    @user = create(:onboarded_user, email: "categories@example.com", password: PASSWORD, password_confirmation: PASSWORD, usage_region: "US")
    @other = create(:onboarded_user, email: "categories-other@example.com", usage_region: "US")
    import(@user, CSV_TEXT)
  end

  test "custom categories can be added, used, renamed and deleted" do
    sign_in @user
    post finance_categories_path, params: {category: {name: "  Pets   and  vets "}}
    assert_redirected_to finance_categories_path(name: "Pets and vets")
    category = @user.finance_custom_categories.sole
    assert_equal "Pets and vets", category.name

    pet = @user.finance_transactions.find_by!(description: "Zorblax Pet Supply 77")
    patch finance_transaction_path(pet), params: {finance_transaction: {category: "Pets and vets"}}
    assert_redirected_to finance_transactions_path
    assert_equal "Pets and vets", pet.reload.category
    # Remembered for the merchant, and applied to the other Uncategorized row from it.
    assert_equal "Pets and vets", @user.finance_merchant_rules.sole.category
    assert_equal "Pets and vets", @user.finance_transactions.find_by!(description: "ZORBLAX PET SUPPLY #4421 CARD 4111111111111111").category

    get finance_categories_path(name: "Pets and vets")
    assert_response :success
    assert_select "h2#detail-heading", text: "Pets and vets"
    assert_select "#detail .bw-table tbody tr", count: 2

    patch finance_category_path(category), params: {category: {name: "Pets"}}
    assert_redirected_to finance_categories_path(name: "Pets")
    assert_equal ["Pets"], @user.finance_transactions.where.not(category: Finance::Transaction::CATEGORIES).distinct.pluck(:category)
    assert_equal "Pets", @user.finance_merchant_rules.sole.category

    delete finance_category_path(category)
    assert_redirected_to finance_categories_path
    assert_equal "Uncategorized", pet.reload.category
    assert_empty @user.finance_merchant_rules.reload
    assert_empty @user.finance_custom_categories.reload
  end

  test "built-in, duplicate, blank and other people's category names are refused" do
    sign_in @user
    post finance_categories_path, params: {category: {name: "Pets"}}
    [["shopping", /built-in/], ["PETS", /already have/], ["   ", /Enter a category name/]].each do |name, message|
      assert_no_difference "Finance::CustomCategory.count" do
        post finance_categories_path, params: {category: {name: name}}
      end
      assert_response :unprocessable_entity
      assert_select "[role=alert], .bw-flash", text: message
    end

    other_category = @other.finance_custom_categories.create!(name: "Secret")
    patch finance_category_path(other_category), params: {category: {name: "Mine now"}}
    assert_response :not_found
    pet = @user.finance_transactions.find_by!(description: "Zorblax Pet Supply 77")
    patch finance_transaction_path(pet), params: {finance_transaction: {category: "Secret"}}
    assert_response :unprocessable_entity
    assert_equal "Uncategorized", pet.reload.category
  end

  test "the categories page lists totals for every category" do
    sign_in @user
    @user.finance_custom_categories.create!(name: "Gifts")
    get finance_categories_path
    assert_response :success
    assert_select "a.bw-nav-link.is-active", text: "Categories"
    assert_select ".bw-table tbody tr", count: Finance::Transaction::CATEGORIES.length + 1
    assert_select ".bw-table tbody tr", text: /Gifts/
    # Where the money goes: the coffee shop was recognized, the rest still needs a category.
    assert_select "#categories-spending-mix .bw-mix-part", count: 2
    assert_select "#categories-spending-mix .bw-mix-part.bw-viz-0[aria-label=?]", "Food & dining: $5.25, 4% of spending"
    assert_select "#categories-spending-mix .bw-mix-part.bw-viz-uncategorized[aria-label=?]", "Uncategorized: $134.10, 96% of spending"
    assert_select "#categories-spending-monthly .bw-col", count: 6
    assert_select "#categories-spending-monthly .bw-col:last-child[aria-label=?]", "Jan 2026: $139.35"
  end

  test "category details chart its months and biggest merchants" do
    sign_in @user
    @user.finance_transactions.where("description ILIKE ?", "%zorblax%").update_all(category: "Shopping")
    get finance_categories_path(name: "Shopping")
    assert_response :success
    assert_select "#categories-spending-mix .bw-mix-part.bw-viz-0[aria-label=?]", "Shopping: $54.10, 39% of spending"
    assert_select "#detail .bw-cat-stat strong", text: "$54.10"
    assert_select "#detail .bw-col", count: 12
    assert_select "#detail .bw-rank-list li", count: 1
    assert_select "#detail .bw-rank-name", text: /Zorblax Pet.*2 transactions/m
  end

  test "AI categorization sends only cleaned merchant text and updates only Uncategorized rows" do
    sign_in @user
    @user.finance_custom_categories.create!(name: "Pets")
    sent = nil
    with_openai_env do
      stub_method(Net::HTTP, :new, transport(->(body) {
        sent = JSON.parse(body)
        items = JSON.parse(sent.dig("input", 0, "content"))["items"]
        answer = items.map do |item|
          category = case item["text"]
          when /zorblax/i then "Pets"
          when /qwerty/i then "Income" # wrong direction: must be ignored
          when /mystery/i then "Uncategorized"
          end
          {key: item["key"], category: category}
        end
        {assignments: answer}
      })) do
        get finance_categories_path
        assert_select "form[action='#{ai_categorize_finance_categories_path}'] input[type=checkbox][required]"
        post ai_categorize_finance_categories_path, params: {consent: "1"}
      end
    end
    assert_redirected_to finance_categories_path
    assert_match(/categorized 2 transactions/, flash[:notice])

    payload = sent.dig("input", 0, "content")
    refute_match(/\d/, JSON.parse(payload)["items"].map { |item| item["text"] }.join)
    refute_match(/42\.10|2026|4111|categories@example/, payload)
    assert_equal false, sent["store"]
    offered = JSON.parse(payload)["categories"]
    assert_includes offered, "Pets"
    refute_includes offered, "Transfers"
    # Two Zorblax rows are one merchant; Starbucks is already categorized and not sent.
    assert_equal 3, JSON.parse(payload)["items"].length
    refute_match(/starbucks/i, payload)

    assert_equal 2, @user.finance_transactions.where(category: "Pets").count
    assert_equal "Uncategorized", @user.finance_transactions.find_by!(description: "QWERTY STUDIO 555-123-4567").category
    assert_equal "Food & dining", @user.finance_transactions.find_by!(description: "STARBUCKS STORE 1234").category
    assert_empty @user.finance_merchant_rules
  end

  test "AI categorization needs consent and has a short cooldown" do
    sign_in @user
    with_openai_env do
      post ai_categorize_finance_categories_path, params: {consent: "0"}
      assert_response :unprocessable_entity
      assert_select ".bw-flash", text: /Tick the box/

      stub_method(Net::HTTP, :new, transport(->(_body) { {assignments: []} })) do
        post ai_categorize_finance_categories_path, params: {consent: "1"}
        assert_redirected_to finance_categories_path
        post ai_categorize_finance_categories_path, params: {consent: "1"}
        assert_response :too_many_requests
      end
    end
  end

  test "the apps' categorize endpoint answers with category names and stores nothing" do
    auth = sign_in_app
    with_openai_env do
      stub_method(Net::HTTP, :new, transport(->(body) {
        items = JSON.parse(JSON.parse(body).dig("input", 0, "content"))["items"]
        {assignments: items.map { |item| {key: item["key"], category: item["text"].match?(/paws/i) ? "Pet care" : "Shopping"} }}
      })) do
        post "/api/client/v1/finance/categorize", headers: auth, as: :json,
          params: {consent: true, categories: ["Pet care"], items: [{key: "a", description: "PAWS PLACE 0042", direction: "out"}, {key: "b", description: "GADGET HUT", direction: "out"}]}
      end
    end
    assert_response :success
    assert_equal [{"key" => "a", "category" => "Pet care"}, {"key" => "b", "category" => "Shopping"}], response.parsed_body["assignments"]
    assert_empty Finance::CustomCategory.where(user_id: @user.id)

    with_openai_env do
      post "/api/client/v1/finance/categorize", headers: auth, as: :json, params: {consent: true, items: [{key: "a", description: "X SHOP", direction: "out"}]}
      assert_response :too_many_requests
      @user.update_column(:finance_ai_categorized_at, nil)
      post "/api/client/v1/finance/categorize", headers: auth, as: :json, params: {consent: false, items: [{key: "a", description: "X SHOP", direction: "out"}]}
      assert_response :unprocessable_entity
      post "/api/client/v1/finance/categorize", headers: auth, as: :json, params: {consent: true, items: [{key: "a", description: "X SHOP", direction: "sideways"}]}
      assert_response :unprocessable_entity
    end
    post "/api/client/v1/finance/categorize", params: {consent: true, items: []}, as: :json
    assert_response :unauthorized
  end

  test "statements uploaded from an app bring their custom categories to the cloud" do
    auth = sign_in_app
    post "/api/client/v1/finance/statements", headers: auth, as: :json, params: {statement: {
      filename: "app.csv", currency: "USD", sha256: "a" * 64, closing_balance: nil, closing_balance_on: nil,
      transactions: [{booked_on: "2026-02-01", description: "PAWS PLACE", amount: "-9.00", category: "Pet care", tax_review: false, excluded: false},
        {booked_on: "2026-02-02", description: "GROCER", amount: "-3.00", category: "Shopping", tax_review: false, excluded: false}]
    }}
    assert_response :created
    assert_equal ["Pet care"], @user.finance_custom_categories.pluck(:name)
    assert_equal "Pet care", @user.finance_transactions.find_by!(description: "PAWS PLACE").category

    get "/api/client/v1/finance/categories", headers: auth, as: :json
    assert_equal ["Pet care"], response.parsed_body["categories"]
  end

  test "CSV imports accept the person's own category names in any letter case" do
    @user.finance_custom_categories.create!(name: "Pet care")
    import(@user, "Date,Description,Amount,Category\n2026-03-01,PAWS PLACE,-9.00,pet CARE\n2026-03-02,OTHER,-1.00,Nonexistent\n")
    assert_equal "Pet care", @user.finance_transactions.find_by!(description: "PAWS PLACE").category
    assert_equal "Uncategorized", @user.finance_transactions.find_by!(description: "OTHER").category
  end

  test "deleting financial data removes custom categories too" do
    @user.finance_custom_categories.create!(name: "Pets")
    Finance::DataDeletion.call(user: @user)
    assert_empty Finance::CustomCategory.where(user_id: @user.id)
  end

  test "clean_text keeps merchant words and drops numbers and email addresses" do
    assert_equal "ZORBLAX PET SUPPLY CARD", Finance::AiCategorizer.clean_text("ZORBLAX PET SUPPLY #4421 CARD 4111111111111111")
    assert_equal "PAY", Finance::AiCategorizer.clean_text("PAY someone@example.com 555-123-4567")
    assert_nil Finance::AiCategorizer.clean_text("12345 #678")
  end

  private

  def import(user, text)
    Tempfile.create(["categories", ".csv"]) do |file|
      file.write(text)
      file.rewind
      Finance::StatementImporter.new(user: user, file: Rack::Test::UploadedFile.new(file.path, "text/csv", original_filename: "categories.csv"), currency: "USD").call
    end
  end

  def sign_in_app
    post "/api/client/v1/session", params: {email: @user.email, password: PASSWORD}, as: :json
    {"Authorization" => "Bearer #{response.parsed_body["token"]}"}
  end

  # A fake OpenAI: `answer` receives the request body and returns the structured output.
  def transport(answer)
    lambda do |_host, _port|
      http = Object.new
      http.define_singleton_method(:request) do |request|
        ok = Net::HTTPOK.new("1.1", "200", "OK")
        text = JSON.generate(answer.call(request.body))
        ok.define_singleton_method(:body) { JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: text}]}]) }
        ok
      end
      %i[use_ssl= open_timeout= read_timeout= write_timeout= max_retries=].each { |name| http.define_singleton_method(name) { |_| } }
      http
    end
  end

  def with_openai_env
    names = %w[OPENAI_API_KEY OPENAI_MODEL OPENAI_REASONING_EFFORT]
    previous = ENV.values_at(*names)
    ENV["OPENAI_API_KEY"] = "test-key"
    ENV["OPENAI_MODEL"] = "test-model"
    ENV.delete("OPENAI_REASONING_EFFORT")
    stub_method(Rails.application, :credentials, {}) { yield }
  ensure
    names.zip(previous).each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end
end
