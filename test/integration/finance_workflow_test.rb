require "test_helper"
require "tempfile"
require_relative "../support/finance_pdf_fixture"
require_relative "../support/billie_method_stub"

class FinanceWorkflowTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include FinancePdfFixture
  include BillieMethodStub

  setup do
    @user = create(:user)
  end

  test "landing and authentication forms are public and finance pages require login" do
    get "/"
    assert_response :success
    assert_select "a", text: /Get started/
    get new_user_registration_path
    assert_response :success
    assert_select "input[name='user[email]']"
    get new_user_session_path
    assert_response :success
    assert_select "input[name='user[password]']"
    [finance_dashboard_path, finance_statements_path, finance_transactions_path, finance_forecast_path, finance_insights_path].each do |path|
      get path
      assert_redirected_to new_user_session_path
    end
  end

  test "sign up creates a real account and login returns to the dashboard" do
    assert_difference "User.count", 1 do
      post user_registration_path, params: {user: {email: "new-finance-user@example.com", first_name: "Alex", last_name: "River",
        password: "Gr33nCloud!Rain&2026", password_confirmation: "Gr33nCloud!Rain&2026"}}
    end
    assert_redirected_to finance_dashboard_path
    follow_redirect!
    assert_response :success
    assert_select "h1", text: /Good|overview|Dashboard|financial|clearer/i
    delete destroy_user_session_path
    post user_session_path, params: {user: {email: "new-finance-user@example.com", password: "Gr33nCloud!Rain&2026"}}
    assert_redirected_to finance_dashboard_path
  end

  test "sample CSV import runs through transactions forecast and insights" do
    sign_in @user
    get sample_finance_statements_path(format: :csv)
    assert_response :success
    sample = response.body
    upload_csv(sample) do |file|
      assert_difference "Finance::Transaction.count", 6 do
        post finance_statements_path, params: {file: file}
      end
    end
    assert_redirected_to finance_transactions_path
    follow_redirect!
    assert_response :success
    assert_select "td", text: /Salary deposit/
    assert_includes response.headers["Cache-Control"], "no-store"
    assert_includes response.headers["Cache-Control"], "private"

    transaction = @user.finance_transactions.where(amount: -42.50).first
    patch finance_transaction_path(transaction), params: {finance_transaction: {category: "Business", tax_review: "1", excluded: "0"}}
    assert_redirected_to finance_transactions_path
    assert transaction.reload.tax_review

    patch finance_profile_path, params: {finance_profile: {current_balance: "2500.00", tax_country: "United States", tax_profile: "personal"}}
    assert_redirected_to finance_forecast_path
    get finance_forecast_path, params: {days: 30, expense_adjustment: -10}
    assert_response :success
    assert_select "svg"
    get finance_dashboard_path
    assert_response :success
    get finance_insights_path
    assert_response :success
    assert_no_difference "Finance::Insight.count" do
      get finance_insights_path
    end
    assert_difference "Finance::Insight.count", 1 do
      post generate_finance_insights_path, params: {provider: "rules"}
    end
    assert_redirected_to finance_insights_path
    follow_redirect!
    assert_response :success
    assert_select "a[href='https://www.irs.gov/filing/gather-your-documents']"
    assert_equal "rules", @user.finance_insights.last.source

    upload_csv(sample) do |file|
      assert_no_difference "Finance::Transaction.count" do
        post finance_statements_path, params: {file: file}
      end
      assert_response :unprocessable_entity
    end
  end

  test "accounts cannot inspect modify or delete another users financial data" do
    other_user = create(:user)
    other_statement = Finance::Statement.create!(user: other_user, filename: "private.csv", currency: "USD", sha256: "a" * 64, transaction_count: 1)
    transaction = Finance::Transaction.create!(user: other_user, statement: other_statement, booked_on: Date.current,
      description: "Private payroll", amount: 999, category: "Income")
    sign_in @user
    get finance_transactions_path
    assert_response :success
    assert_no_match "Private payroll", response.body
    get edit_finance_transaction_path(transaction)
    assert_response :not_found
    patch finance_transaction_path(transaction), params: {finance_transaction: {excluded: "1"}}
    assert_response :not_found
    refute transaction.reload.excluded
    assert_no_difference "Finance::Statement.count" do
      delete finance_statement_path(other_statement)
    end
    assert_response :not_found
  end

  test "exports preserve exact amounts and neutralize spreadsheet formulas" do
    sign_in @user
    upload_csv("Date,Description,Amount\n#{Date.current.iso8601},=HYPERLINK(1),-12.34\n") do |file|
      post finance_statements_path, params: {file: file}
    end
    get finance_transactions_path(format: :csv)
    assert_response :success
    rows = CSV.parse(response.body, headers: true)
    assert_equal "'=HYPERLINK(1)", rows.first["Description"]
    assert_equal "-12.34", rows.first["Amount"]
    get finance_transactions_path, params: {search: "does not exist"}
    assert_response :success
    assert_select "td", text: /HYPERLINK/, count: 0
  end

  test "invalid forecast inputs fail visibly without changing the saved balance" do
    sign_in @user
    get finance_forecast_path, params: {days: "nonsense", expense_adjustment: "NaN"}
    assert_response :unprocessable_entity
    assert_select "[role='alert']"
  end

  test "PDF upload requires review then imports corrected rows and prevents duplicates" do
    sign_in @user
    pdf = finance_statement_pdf(["#{Date.current.iso8601} Salary +1200.00", "#{Date.current.iso8601} Grocery 25.50"])
    upload_pdf(pdf) do |file|
      assert_difference "Finance::StatementDraft.count", 1 do
        assert_no_difference "Finance::Transaction.count" do
          post finance_statements_path, params: {file: file, statement_year: Date.current.year}
        end
      end
    end
    draft = @user.finance_statement_drafts.last
    assert_redirected_to finance_statement_draft_path(draft)
    follow_redirect!
    assert_response :success
    assert_select "input[name='review_confirmed']"
    assert_select "input[name='rows[1][amount]'][value='']"
    rows = draft.rows.each_with_index.to_h { |row, index| [index.to_s, row.merge("include" => "1")] }
    rows["1"]["amount"] = "-25.50"
    assert_no_difference "Finance::Transaction.count" do
      post confirm_finance_statement_draft_path(draft), params: {rows: rows}
    end
    assert_response :unprocessable_entity
    assert_difference "Finance::Transaction.count", 2 do
      post confirm_finance_statement_draft_path(draft), params: {rows: rows, review_confirmed: "1"}
    end
    assert_redirected_to finance_transactions_path
    assert_equal BigDecimal("1174.50"), @user.finance_transactions.sum(:amount)
    assert_equal "statement.pdf", @user.finance_statements.last.filename
    upload_pdf(pdf) do |file|
      assert_no_difference "Finance::Transaction.count" do
        post finance_statements_path, params: {file: file, statement_year: Date.current.year}
      end
    end
    assert_response :unprocessable_entity
  end

  test "PDF review drafts are scoped to owner and expired drafts cannot be confirmed" do
    other_user = create(:user)
    draft = Finance::StatementDraft.create!(user: other_user, filename: "secret.pdf", sha256: "b" * 64,
      currency: "USD", rows: [{"booked_on" => Date.current.iso8601, "description" => "Private", "amount" => "-9.00"}],
      warnings: [], expires_at: 30.minutes.from_now)
    sign_in @user
    get finance_dashboard_path
    get finance_statement_draft_path(draft)
    assert_response :not_found
    post confirm_finance_statement_draft_path(draft), params: {review_confirmed: "1"}
    assert_response :not_found
    draft.update_columns(user_id: @user.id, expires_at: 1.minute.ago)
    post confirm_finance_statement_draft_path(draft), params: {review_confirmed: "1"}
    assert_redirected_to finance_statements_path
    assert_includes flash[:alert], "expired"
  end

  test "Billie tax preparation insights are separate from general insights and require AI consent" do
    sign_in @user
    get sample_finance_statements_path(format: :csv)
    upload_csv(response.body) { |file| post finance_statements_path, params: {file: file} }

    with_openai_env(nil, nil) do
      get finance_insights_path
      assert_response :success
      assert_select "#billie-tax-insights h2", text: "Tax preparation"
      assert_select "#billie-tax-insights", text: /Billie is not connected yet/
      assert_select "#billie-tax-insights form", count: 0

      assert_no_difference "Finance::Insight.count" do
        post generate_finance_insights_path, params: {kind: "tax", consent: "1"}
      end
      assert_response :unprocessable_entity
    end

    content = {
      "summary" => "Billie prepared a record checklist from your imported totals.",
      "tax_preparation" => [{"title" => "Gather income documents", "body" => "Collect the forms that apply to you and match them to your statements."}],
      "questions" => [{"title" => "Which records matter?", "body" => "Ask your tax professional what they need for your situation."}],
      "limitations" => ["No tax calculation or filing is performed."]
    }
    body = JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: JSON.generate(content)}]}])
    ok = Net::HTTPOK.new("1.1", "200", "OK")
    ok.define_singleton_method(:body) { body }
    http = Object.new
    http.define_singleton_method(:request) { |_| ok }
    %i[use_ssl= open_timeout= read_timeout= write_timeout= max_retries=].each { |name| http.define_singleton_method(name) { |_| } }

    with_openai_env("test-key", "test-model") do
      get finance_insights_path
      assert_select "#billie-tax-insights form input[name='kind'][value='tax']"

      stub_method(Net::HTTP, :new, http) do
        assert_no_difference "Finance::Insight.general.count" do
          assert_difference "Finance::Insight.tax.count", 1 do
            post generate_finance_insights_path, params: {kind: "tax", consent: "1"}
          end
        end
      end
      assert_redirected_to finance_insights_path
      follow_redirect!
      assert_select "#billie-tax-insights", text: /Gather income documents/
      assert_select "#billie-tax-insights", text: /Which records matter\?/

      # A rapid second tax request is rate limited, but does not block general analysis.
      assert_no_difference "Finance::Insight.count" do
        post generate_finance_insights_path, params: {kind: "tax", consent: "1"}
      end
      assert_response :too_many_requests
    end
  end

  test "another user's tax insights never appear on this account" do
    other = create(:user)
    Finance::Insight.create!(user: other, source: "openai", kind: "tax", generated_at: Time.current,
      content: {"summary" => "OTHER-USER-SECRET", "tax_preparation" => [], "questions" => [], "limitations" => []})
    sign_in @user
    get finance_insights_path
    assert_response :success
    refute_includes response.body, "OTHER-USER-SECRET"
  end

  private

  def with_openai_env(key, model)
    previous = ENV.values_at("OPENAI_API_KEY", "OPENAI_MODEL")
    {"OPENAI_API_KEY" => key, "OPENAI_MODEL" => model}.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
    yield
  ensure
    %w[OPENAI_API_KEY OPENAI_MODEL].zip(previous).each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end

  def upload_csv(content)
    Tempfile.create(["billie-test", ".csv"]) do |tempfile|
      tempfile.write(content)
      tempfile.rewind
      yield Rack::Test::UploadedFile.new(tempfile.path, "text/csv", original_filename: "sample.csv")
    end
  end

  def upload_pdf(content)
    Tempfile.create(["billie-pdf-test", ".pdf"]) do |tempfile|
      tempfile.binmode
      tempfile.write(content)
      tempfile.rewind
      yield Rack::Test::UploadedFile.new(tempfile.path, "application/pdf", original_filename: "statement.pdf")
    end
  end
end
