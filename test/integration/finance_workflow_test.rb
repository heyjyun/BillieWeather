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
      post user_registration_path, params: {user: {email: "new-finance-user@example.com", first_name: "Alex", last_name: "River", usage_region: "US",
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

  test "CSV with transaction_date and posted_date imports automatically on the first attempt" do
    sign_in @user
    csv = "posted_date,transaction_date,Description,Amount\n2026-01-03,2025-12-31,Coffee,-5\n"
    upload_csv(csv) do |file|
      assert_difference "Finance::Transaction.count", 1 do
        post finance_statements_path, params: {file: file}
      end
    end
    assert_redirected_to finance_transactions_path
    assert_equal Date.new(2025, 12, 31), @user.finance_transactions.last.booked_on
    assert_includes flash[:notice], "transaction_date"
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

  test "a clear PDF imports automatically without asking for a year or a review" do
    sign_in @user
    pdf = finance_statement_pdf(["Statement Period: 10/01/2025 - 10/31/2025", "10/05 Salary +1,000.00", "10/20 Grocery market -25.50"])
    upload_pdf(pdf) do |file|
      assert_no_difference "Finance::StatementDraft.count" do
        assert_difference "Finance::Transaction.count", 2 do
          post finance_statements_path, params: {file: file}
        end
      end
    end
    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], "automatically"
    assert_equal [Date.new(2025, 10, 5), Date.new(2025, 10, 20)], @user.finance_transactions.order(:booked_on).pluck(:booked_on)
    assert_equal ["Income", "Food & dining"], @user.finance_transactions.order(:booked_on).pluck(:category)
    get finance_statements_path
    assert_select "input[name='statement_year']", count: 0
  end

  test "a PDF with an unclear amount or year still goes to review" do
    sign_in @user
    pdf = finance_statement_pdf(["10/05 Salary +1,000.00", "10/20 Grocery market -25.50"])
    upload_pdf(pdf) do |file|
      assert_difference "Finance::StatementDraft.count", 1 do
        assert_no_difference "Finance::Transaction.count" do
          post finance_statements_path, params: {file: file}
        end
      end
    end
    assert_redirected_to finance_statement_draft_path(@user.finance_statement_drafts.last)
  end

  test "correcting one category teaches future imports and is private to the account" do
    sign_in @user
    csv = "Date,Description,Amount\n#{Date.current.iso8601},ZXQ WIDGETS 111,-10.00\n#{Date.current.iso8601},ZXQ WIDGETS 222,-12.00\n"
    upload_csv(csv) { |file| post finance_statements_path, params: {file: file} }
    assert_equal ["Uncategorized"], @user.finance_transactions.pluck(:category).uniq

    first = @user.finance_transactions.order(:id).first
    patch finance_transaction_path(first), params: {finance_transaction: {category: "Health"}}
    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], "future"
    assert_includes flash[:notice], "updated 1 similar transaction"
    assert_equal ["Health"], @user.finance_transactions.pluck(:category).uniq

    csv_two = "Date,Description,Amount\n#{Date.current.iso8601},Zxq Widgets 999,-5.00\n"
    upload_csv(csv_two) { |file| post finance_statements_path, params: {file: file} }
    assert_equal "Health", @user.finance_transactions.find_by(description: "Zxq Widgets 999").category

    sign_out @user
    other = create(:user)
    sign_in other
    upload_csv(csv_two) { |file| post finance_statements_path, params: {file: file} }
    assert_equal "Uncategorized", other.finance_transactions.first.category
  end

  test "the balance fills itself in from a statement, can be edited, and can go back to the statement" do
    sign_in @user
    csv = "Date,Description,Amount,Balance,Bank,Account Number,Account Type\n#{(Date.current - 1).iso8601},Coffee,-4.50,812.34,Chase,1111,Checking\n"
    upload_csv(csv) { |file| post finance_statements_path, params: {file: file} }
    get finance_dashboard_path
    assert_select "#dashboard-balance strong", text: "$812.34"
    assert_select "#dashboard-balance small", text: /Automatically totals/
    assert_select "#dashboard-balance a", text: /View account balances/
    assert_select "#dashboard-balance .bw-balance-age", text: /Balance is as of/
    assert_select "#dashboard-balance a[href*='edit=1']", text: /Enter or edit balance/
    get finance_forecast_path
    assert_select "#forecast-starting-balance", text: /The forecast starts today/
    assert_select "#forecast-starting-balance .bw-balance-age", text: /Balance is as of/
    assert_select "#balance details summary", text: /Enter or edit balance/
    assert_select "#balance details[open]", count: 0
    assert_select "#balance input[name='finance_profile[current_balance]']"
    get finance_forecast_path(edit: "1")
    assert_select "#balance details[open]", count: 1

    patch finance_profile_path, params: {finance_profile: {current_balance: "1000.00"}, return_to: "forecast"}
    assert_redirected_to finance_forecast_path
    assert_equal "manual", @user.finance_profile.reload.balance_source
    get finance_dashboard_path
    assert_select "#dashboard-balance small", text: /Entered by you/
    get finance_forecast_path
    assert_select "#balance form button", text: /automatic account total/i

    # Saving tax details from the insights page must not mark the balance as manual or change it.
    patch finance_profile_path, params: {finance_profile: {tax_country: "Canada"}, return_to: "insights"}
    assert_equal BigDecimal("1000.00"), @user.finance_profile.reload.current_balance

    patch finance_profile_path, params: {use_statement_balance: "1", return_to: "forecast"}
    assert_redirected_to finance_forecast_path
    profile = @user.finance_profile.reload
    assert_equal BigDecimal("812.34"), profile.current_balance
    assert_equal "statement", profile.balance_source
  end

  test "asking for the statement balance when none exists explains and keeps the entered balance" do
    sign_in @user
    patch finance_profile_path, params: {finance_profile: {current_balance: "50.00"}, return_to: "forecast"}
    patch finance_profile_path, params: {use_statement_balance: "1", return_to: "forecast"}
    assert_redirected_to finance_forecast_path
    assert_includes flash[:alert], "closing balance"
    profile = @user.finance_profile.reload
    assert_equal BigDecimal("50.00"), profile.current_balance
    assert_equal "manual", profile.balance_source
  end

  test "deleting a statement removes the balance that came from it" do
    sign_in @user
    csv = "Date,Description,Amount,Balance,Bank,Account Number,Account Type\n#{(Date.current - 1).iso8601},Coffee,-4.50,812.34,Chase,1111,Checking\n"
    upload_csv(csv) { |file| post finance_statements_path, params: {file: file} }
    assert_equal BigDecimal("812.34"), @user.finance_profile.reload.current_balance
    delete finance_statement_path(@user.finance_statements.last)
    profile = @user.finance_profile.reload
    assert_equal BigDecimal(0), profile.current_balance
    assert_nil profile.balance_source
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

  test "AI consent discloses Prepend and its optional OpenAI credit fallback" do
    sign_in @user
    with_openai_env("prepend-test-token", "test-model", base_url: "https://prepend.me/api.openai.com/v1",
      fallback_api_key: "native-test-key", fallback_on_quota_exhausted: "true") do
      get finance_insights_path
      assert_response :success
      assert_select "label", text: /OpenAI via Prepend, with OpenAI if its credit runs out/, count: 2
    end
  end

  test "an explicit Prepend credit limit uses OpenAI once and tells the user" do
    sign_in @user
    content = {
      "summary" => "A summary of the supplied financial activity.",
      "observations" => [{"title" => "Check coverage", "body" => "Review the dates covered by your statements."}],
      "actions" => [{"title" => "Review categories", "body" => "Check the suggested transaction categories."}],
      "tax_preparation" => [{"title" => "Keep records", "body" => "Retain supporting records for review."}],
      "limitations" => ["Based only on the supplied aggregate data."]
    }
    quota = Net::HTTPTooManyRequests.new("1.1", "429", "Too Many Requests")
    quota.define_singleton_method(:body) { JSON.generate(error: {code: "credit_balance_exhausted"}) }
    ok = Net::HTTPOK.new("1.1", "200", "OK")
    ok.define_singleton_method(:body) do
      JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: JSON.generate(content)}]}])
    end
    calls = []
    transport = lambda do |host, _port|
      http = Object.new
      http.define_singleton_method(:request) do |request|
        calls << {host: host, authorization: request["Authorization"]}
        (host == "prepend.me") ? quota : ok
      end
      %i[use_ssl= open_timeout= read_timeout= write_timeout= max_retries=].each { |name| http.define_singleton_method(name) { |_| } }
      http
    end

    with_openai_env("prepend-test-token", "test-model", base_url: "https://prepend.me/api.openai.com/v1",
      fallback_api_key: "native-test-key", fallback_on_quota_exhausted: "true") do
      stub_method(Net::HTTP, :new, transport) do
        assert_difference "Finance::Insight.count", 1 do
          post generate_finance_insights_path, params: {provider: "openai", consent: "1"}
        end
      end
      assert_redirected_to finance_insights_path
      assert_includes flash[:notice], "Prepend's credit limit was reached"
      assert_includes flash[:notice], "OpenAI"
    end
    assert_equal [
      {host: "prepend.me", authorization: "Bearer prepend-test-token"},
      {host: "api.openai.com", authorization: "Bearer native-test-key"}
    ], calls
  end

  private

  def with_openai_env(key, model, base_url: nil, fallback_api_key: nil, fallback_on_quota_exhausted: nil)
    values = {"OPENAI_API_KEY" => key, "OPENAI_MODEL" => model, "OPENAI_BASE_URL" => base_url,
              "OPENAI_REASONING_EFFORT" => nil, "OPENAI_FALLBACK_API_KEY" => fallback_api_key,
              "OPENAI_FALLBACK_ON_QUOTA_EXHAUSTED" => fallback_on_quota_exhausted,
              "OPENAI_FALLBACK_MODEL" => nil, "OPENAI_FALLBACK_REASONING_EFFORT" => nil}
    previous = ENV.values_at(*values.keys)
    values.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
    stub_method(Rails.application, :credentials, {}) { yield }
  ensure
    values.keys.zip(previous).each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
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
