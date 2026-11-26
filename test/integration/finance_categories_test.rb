require "test_helper"
require "tempfile"
require_relative "../support/billie_method_stub"

# The Categories page: custom categories, category details, and "Categorize with AI"
# (website and the apps' API).
class FinanceCategoriesTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  # Exercises optional modules (hidden by default since the Feature Library): sign people in with them on.
  include BillieModules::SignInWithFullSidebar
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
    category = Finance::Category.where(user_id: @user.id).find_by!(name: "Pets and vets")
    assert_nil category.system_key
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
    assert_equal ["Pets"], @user.finance_transactions.where("description ILIKE ?", "%zorblax%").distinct.pluck(:category)
    assert_equal "Pets", @user.finance_merchant_rules.sole.category

    delete finance_category_path(category)
    assert_redirected_to finance_categories_path
    assert_equal "Uncategorized", pet.reload.category
    assert_empty @user.finance_merchant_rules.reload
    refute Finance::Category.where(user_id: @user.id, name: "Pets").exists?
  end

  test "built-in, duplicate, blank and other people's category names are refused" do
    sign_in @user
    post finance_categories_path, params: {category: {name: "Pets"}}
    [["uncategorized", /fixed/], ["shopping", /already have/], ["PETS", /already have/], ["   ", /Enter a category name/]].each do |name, message|
      assert_no_difference "Finance::Category.count" do
        post finance_categories_path, params: {category: {name: name}}
      end
      assert_response :unprocessable_entity
      assert_select "[role=alert], .bw-flash", text: message
    end

    other_category = Finance::Category.create_for!(@other, name: "Secret")
    patch finance_category_path(other_category), params: {category: {name: "Mine now"}}
    assert_response :not_found
    pet = @user.finance_transactions.find_by!(description: "Zorblax Pet Supply 77")
    patch finance_transaction_path(pet), params: {finance_transaction: {category: "Secret"}}
    assert_response :unprocessable_entity
    assert_equal "Uncategorized", pet.reload.category
  end

  test "the categories page lists totals for every category" do
    sign_in @user
    Finance::Category.create_for!(@user, name: "Party supplies")
    get finance_categories_path
    assert_response :success
    assert_select "a.bw-nav-link.is-active", text: "Categories & Tags"
    # Every category in tree order (defaults, their own) plus Uncategorized.
    assert_select ".bw-table tbody tr", count: 84 + 1 + 1
    assert_select ".bw-table tbody tr", text: /Party supplies/
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
    Finance::Category.create_for!(@user, name: "Pets")
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
    # The run is one audited batch and the page offers to undo it (Phase 0.5, audit R3).
    batch_id = flash[:ai_batch_id]
    assert_equal 2, Finance::AuditEvent.where(user_id: @user.id, batch_id: batch_id, actor: "ai", action: "ai_apply").count
    follow_redirect!
    assert_select "form#ai-undo[action='#{finance_undo_activity_path(batch_id)}']"
    assert_select ".bw-flash", text: /#{batch_id}/, count: 0

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
    refute Finance::Category.where(user_id: @user.id, name: "Pet care").exists?

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
    assert Finance::Category.where(user_id: @user.id, name: "Pet care", parent_id: nil).exists?
    assert_equal "Pet care", @user.finance_transactions.find_by!(description: "PAWS PLACE").category

    get "/api/client/v1/finance/categories", headers: auth, as: :json
    assert_includes response.parsed_body["categories"], "Pet care"
    refute_includes response.parsed_body["categories"], "Shopping"
  end

  test "CSV imports accept the person's own category names in any letter case" do
    Finance::Category.create_for!(@user, name: "Pet care")
    import(@user, "Date,Description,Amount,Category\n2026-03-01,PAWS PLACE,-9.00,pet CARE\n2026-03-02,OTHER,-1.00,Nonexistent\n")
    assert_equal "Pet care", @user.finance_transactions.find_by!(description: "PAWS PLACE").category
    assert_equal "Uncategorized", @user.finance_transactions.find_by!(description: "OTHER").category
  end

  test "deleting financial data removes categories too" do
    Finance::Category.create_for!(@user, name: "Pets")
    Finance::DataDeletion.call(user: @user)
    assert_empty Finance::Category.where(user_id: @user.id)
  end

  test "AI proposals are never created automatically; approving creates the subcategory and files its groups as one undoable batch" do
    sign_in @user
    sent = nil
    with_openai_env do
      stub_method(Net::HTTP, :new, transport(->(body) {
        sent = JSON.parse(body)
        items = JSON.parse(sent.dig("input", 0, "content"))["items"]
        zorblax = items.select { |item| item["text"].match?(/zorblax/i) }.map { |item| item["key"] }
        {assignments: items.map { |item| {key: item["key"], category: "Uncategorized"} },
         proposals: [{parent: "Family & pets", name: "Pet shops", keys: zorblax},
           {parent: "Food & dining", name: "groceries", keys: zorblax}, # already exists: dropped
           {parent: "Nonexistent", name: "Nope", keys: zorblax}]}
      })) do
        post ai_categorize_finance_categories_path, params: {consent: "1"}
      end
    end
    offered = JSON.parse(sent.dig("input", 0, "content"))["categories"]
    assert_includes offered, "Food & dining › Groceries"
    refute offered.any? { |path| path.start_with?("Transfers") }
    assert_equal %w[assignments proposals], sent.dig("text", "format", "schema", "required")

    refute Finance::Category.where(user_id: @user.id, name: "Pet shops").exists?
    proposal = @user.finance_category_proposals.pending.sole
    assert_equal ["Family & pets", "Pet shops"], [proposal.parent_name, proposal.name]
    assert_equal 2, proposal.transaction_ids.length
    follow_redirect!
    assert_select "#category-proposals #proposal-#{proposal.id}"

    post approve_finance_category_proposal_path(proposal), params: {name: "Pet stores"}
    assert_redirected_to finance_categories_path(name: "Pet stores")
    created = Finance::Category.where(user_id: @user.id).find_by!(name: "Pet stores")
    assert_equal "Family & pets", created.parent.name
    pets = @user.finance_transactions.where("description ILIKE ?", "%zorblax%")
    assert_equal ["Pet stores"], pets.distinct.pluck(:category)
    batch_id = flash[:ai_batch_id]
    assert_equal 2, Finance::AuditEvent.where(user_id: @user.id, batch_id: batch_id, action: "ai_apply").count
    assert_equal "approved", proposal.reload.status

    post finance_undo_activity_path(batch_id)
    assert_equal ["Uncategorized"], pets.reload.distinct.pluck(:category)
  end

  test "AI proposals can be dismissed" do
    sign_in @user
    proposal = @user.finance_category_proposals.create!(parent_name: "Shopping", name: "Gadgets", payload: {"transaction_ids" => [], "texts" => ["GADGET"]})
    post dismiss_finance_category_proposal_path(proposal)
    assert_equal "dismissed", proposal.reload.status
    refute Finance::Category.where(user_id: @user.id, name: "Gadgets").exists?
    post approve_finance_category_proposal_path(proposal)
    assert_match(/already handled/, flash[:alert])
    other = @other.finance_category_proposals.create!(parent_name: "Shopping", name: "Theirs", payload: {})
    post approve_finance_category_proposal_path(other)
    assert_response :not_found
  end

  test "the apps' category list keeps its old meaning and adds the tree" do
    auth = sign_in_app
    Finance::Category.create_for!(@user, name: "Pet care", parent: "Family & pets")
    get "/api/client/v1/finance/categories", headers: auth, as: :json
    assert_response :success
    body = response.parsed_body
    refute_includes body["categories"], "Food & dining"
    refute_includes body["categories"], "Transfers"
    assert_includes body["categories"], "Groceries"
    assert_includes body["categories"], "Pet care"
    tree = body["tree"]
    assert_equal 85, tree.length
    names = tree.map { |node| node["name"] }
    tree.each { |node| assert names.index(node["parent"]) < names.index(node["name"]) if node["parent"] }
    food = tree.find { |node| node["name"] == "Food & dining" }
    assert_equal({"name" => "Food & dining", "parent" => nil, "kind" => "expense", "key" => "food", "sort_order" => 3, "hidden" => false}, food)
    assert_equal({"name" => "Pet care", "parent" => "Family & pets", "kind" => "expense", "key" => nil}, tree.find { |node| node["name"] == "Pet care" }.slice("name", "parent", "kind", "key"))
    refute tree.first.key?("expanded")
  end

  test "statements uploaded from an app can describe categories with their parents" do
    auth = sign_in_app
    post "/api/client/v1/finance/statements", headers: auth, as: :json, params: {statement: {
      filename: "app.csv", currency: "USD", sha256: "b" * 64,
      categories: [{name: "Hobby gear", parent: nil, kind: "expense"}, {name: "Climbing", parent: "Hobby gear", kind: "expense"}, {name: "Groceries", parent: "Shopping"}],
      transactions: [{booked_on: "2026-02-01", description: "ROCK GYM", amount: "-9.00", category: "Climbing", tax_review: false, excluded: false},
        {booked_on: "2026-02-02", description: "MYSTERY", amount: "-3.00", category: "Brand new", tax_review: false, excluded: false}]
    }}
    assert_response :created
    tree = Finance::CategoryTree.new(@user)
    assert_equal "Hobby gear", tree.parent_of("Climbing")
    assert_equal "Food & dining", tree.parent_of("Groceries") # existing categories are never moved
    assert_nil tree.parent_of("Brand new")
    assert_equal "Climbing", @user.finance_transactions.find_by!(description: "ROCK GYM").category
  end

  test "the apps' categorize endpoint accepts paths and returns proposals without storing them" do
    auth = sign_in_app
    with_openai_env do
      stub_method(Net::HTTP, :new, transport(->(body) {
        content = JSON.parse(JSON.parse(body).dig("input", 0, "content"))
        assert_includes content["categories"], "Food & dining › Groceries"
        {assignments: [{key: "a", category: "Food & dining › Groceries"}], proposals: [{parent: "Food & dining › Groceries", name: "Bulk stores", keys: ["a"]}]}
      })) do
        post "/api/client/v1/finance/categorize", headers: auth, as: :json,
          params: {consent: true, categories: ["Food & dining", "Food & dining › Groceries"], items: [{key: "a", description: "BULK BARN", direction: "out"}]}
      end
    end
    assert_response :success
    assert_equal [{"key" => "a", "category" => "Groceries"}], response.parsed_body["assignments"]
    assert_equal [{"parent" => "Groceries", "name" => "Bulk stores", "keys" => ["a"]}], response.parsed_body["proposals"]
    assert_empty @user.finance_category_proposals
    refute Finance::Category.where(user_id: @user.id, name: "Bulk stores").exists?
  end

  test "the categories page shows the tree collapsed, remembers expansion and adds suggested categories" do
    sign_in @user
    get finance_categories_path
    assert_response :success
    food = Finance::Category.where(user_id: @user.id).find_by!(name: "Food & dining")
    assert_select "#category-tree details[data-category-expand-url='#{expand_finance_category_path(food, format: :json)}']:not([open])"
    patch expand_finance_category_path(food, format: :json), params: {expanded: true}, as: :json
    assert_response :no_content
    assert food.reload.expanded
    get finance_categories_path
    assert_select "#category-tree details[open][data-category-expand-url='#{expand_finance_category_path(food, format: :json)}']"

    Finance::Category.where(user_id: @user.id, name: "Coffee & tea").sole.remove!
    post add_suggested_finance_categories_path
    assert_redirected_to finance_categories_path(anchor: "category-tree")
    assert_match(/Added 1 suggested category/, flash[:notice])
    assert_equal "Food & dining", Finance::CategoryTree.new(@user).parent_of("Coffee & tea")
  end

  test "categories can be created under any parent, moved, reordered and merged from the page" do
    sign_in @user
    post finance_categories_path, params: {category: {name: "Farmers market", parent_name: "Groceries"}}
    assert_redirected_to finance_categories_path(name: "Farmers market")
    post finance_categories_path, params: {category: {name: "Stalls", parent_name: "Farmers market"}}
    tree = Finance::CategoryTree.new(@user)
    assert_equal ["Food & dining", "Groceries", "Farmers market", "Stalls"], tree.path_names("Stalls")

    market = Finance::Category.where(user_id: @user.id).find_by!(name: "Farmers market")
    patch move_finance_category_path(market), params: {parent_name: "Stalls"}
    assert_match(/inside itself/, flash[:alert])
    patch move_finance_category_path(market), params: {parent_name: "Shopping"}
    assert_equal "Shopping", Finance::CategoryTree.new(@user).parent_of("Farmers market")

    first = Finance::CategoryTree.new(@user).node("Shopping").children.first.name
    patch reorder_finance_category_path(market), params: {direction: "up"}
    refute_equal first, Finance::CategoryTree.new(@user).node("Shopping").children.last.name if first != "Farmers market"

    transfers = Finance::Category.where(user_id: @user.id).find_by!(system_key: "transfers")
    delete finance_category_path(transfers)
    assert_match(/stays a top-level category/, flash[:alert])
    assert Finance::Category.exists?(transfers.id)
    patch finance_category_path(transfers), params: {category: {name: "Money moves"}}
    assert_equal "Money moves", transfers.reload.name

    post merge_finance_category_path(market), params: {into: "Clothing & shoes"}
    assert_equal "Clothing & shoes", Finance::CategoryTree.new(@user).parent_of("Stalls")
    refute Finance::Category.exists?(market.id)

    get finance_ledger_report_path(preset: "all_time")
    assert_response :success
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
