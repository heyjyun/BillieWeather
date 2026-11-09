require "test_helper"
require "tempfile"
require_relative "../support/finance_pdf_fixture"
require_relative "../support/billie_method_stub"

class FinanceLocalizedWorkflowTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
  include FinancePdfFixture
  include BillieMethodStub

  setup do
    @user = create(:user)
    sign_in @user
    get finance_statements_path, params: {locale: "zh-CN"}
    assert_response :success
  end

  test "Chinese CSV import localizes notices and errors while preserving canonical data and export headers" do
    csv = "Date,Description,Amount,Category,Balance,Bank,Account Number,Account Type\n#{Date.current.iso8601},超市采购,-25.50,Food & dining,800.00,Chase,1234,Checking\n"
    with_upload(csv, "中文账单.csv", "text/csv") do |file|
      assert_difference "@user.finance_transactions.count", 1 do
        post finance_statements_path, params: {file: file}
      end
    end
    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], "已从"
    assert_includes flash[:notice], "Date"
    transaction = @user.finance_transactions.last
    assert_equal "超市采购", transaction.description
    assert_equal "Food & dining", transaction.category
    assert_equal "Checking", @user.finance_bank_accounts.last.name
    assert_equal BigDecimal("800.00"), @user.finance_profile.reload.current_balance

    get finance_transactions_path(format: :csv)
    assert_response :success
    rows = CSV.parse(response.body, headers: true)
    assert_equal ["Date", "Description", "Amount", "Currency", "Category", "Tax review", "Excluded"], rows.headers
    assert_equal "Food & dining", rows.first["Category"]
    assert_equal "超市采购", rows.first["Description"]

    with_upload("Date,Description,Amount\n#{Date.current.iso8601},无效金额,abc\n", "invalid.csv", "text/csv") do |file|
      assert_no_difference ["@user.finance_statements.count", "@user.finance_transactions.count"] do
        post finance_statements_path, params: {file: file}
      end
    end
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /第 2 行.*金额/
  end

  test "Chinese PDF extraction keeps automatic import classification and review confirmation intact across languages" do
    clear_pdf = finance_statement_pdf(["Statement Period: 10/01/2025 - 10/31/2025", "10/05 Salary +1,000.00", "10/20 Grocery market -25.50"])
    with_upload(clear_pdf, "clear.pdf", "application/pdf") do |file|
      assert_no_difference "@user.finance_statement_drafts.count" do
        assert_difference "@user.finance_transactions.count", 2 do
          post finance_statements_path, params: {file: file}
        end
      end
    end
    assert_redirected_to finance_transactions_path
    assert_includes flash[:notice], "自动导入"

    unclear_pdf = finance_statement_pdf(["2026-11-01 Pharmacy 18.20"])
    with_upload(unclear_pdf, "review.pdf", "application/pdf") do |file|
      assert_difference "@user.finance_statement_drafts.count", 1 do
        assert_no_difference "@user.finance_transactions.count" do
          post finance_statements_path, params: {file: file}
        end
      end
    end
    draft = @user.finance_statement_drafts.last
    assert_redirected_to finance_statement_draft_path(draft)
    assert_not draft.auto_importable?
    assert (Finance::PdfStatementExtractor::GENERIC_NOTICES - draft.warnings).empty?
    assert draft.actionable_warnings.any? { |warning| warning.include?("借贷方向") }
    follow_redirect!
    assert_response :success
    assert_includes response.body, "PDF 布局各异"
    assert_no_match(/translation_missing|Translation missing/, response.body)

    get finance_statement_draft_path(draft), params: {locale: "en"}
    assert_response :success
    assert_not draft.reload.auto_importable?
    rows = {"0" => draft.rows.first.merge("amount" => "-18.20", "include" => "1")}
    assert_no_difference "@user.finance_transactions.count" do
      post confirm_finance_statement_draft_path(draft), params: {rows: rows}
    end
    assert_response :unprocessable_entity
    assert_select "[role='alert']", text: /Confirm that you checked/
    assert_difference "@user.finance_transactions.count", 1 do
      post confirm_finance_statement_draft_path(draft), params: {rows: rows, review_confirmed: "1"}
    end
    assert_redirected_to finance_transactions_path
    assert_equal BigDecimal("-18.20"), @user.finance_transactions.find_by!(description: "Pharmacy").amount
  end

  test "new basic analysis follows the current language and retains saved report content" do
    csv = "Date,Description,Amount,Category\n#{Date.current.iso8601},Salary,1000.00,Income\n#{Date.current.iso8601},Groceries,-25.50,Food & dining\n"
    with_upload(csv, "analysis.csv", "text/csv") { |file| post finance_statements_path, params: {file: file} }
    assert_difference "@user.finance_insights.count", 1 do
      post generate_finance_insights_path, params: {provider: "rules"}
    end
    assert_redirected_to finance_insights_path
    assert_includes flash[:notice], "基础分析"
    chinese_report = @user.finance_insights.last
    assert_includes chinese_report.content.fetch("summary"), "收入"
    category_observation = chinese_report.content.fetch("observations").find { |item| item["title"] == "支出最多的分类" }
    assert_includes category_observation.fetch("body"), "餐饮"
    assert_not_includes category_observation.fetch("body"), "Food & dining"
    assert_equal ["Food & dining", "Income"], @user.finance_transactions.order(:category).pluck(:category)

    get finance_insights_path, params: {locale: "en"}
    assert_response :success
    assert_includes response.body, chinese_report.content.fetch("summary")
    post generate_finance_insights_path, params: {provider: "rules"}
    assert_redirected_to finance_insights_path
    english_report = @user.finance_insights.order(:id).last
    assert_includes english_report.content.fetch("summary"), "Your imported activity"
    assert_equal chinese_report.content, chinese_report.reload.content
  end

  test "new AI analysis requests the selected language with unchanged schema keys and aggregate categories" do
    content = {
      "summary" => "请核对已导入的财务记录。",
      "observations" => [{"title" => "检查范围", "body" => "请核对账单日期范围。"}],
      "actions" => [{"title" => "核对分类", "body" => "请检查交易分类。"}],
      "tax_preparation" => [{"title" => "整理凭证", "body" => "保留原始文件供复核。"}],
      "limitations" => ["仅基于提供的汇总数据。"]
    }
    response_body = JSON.generate(status: "completed", output: [{type: "message", content: [{type: "output_text", text: JSON.generate(content)}]}])
    successful_response = Net::HTTPOK.new("1.1", "200", "OK")
    successful_response.define_singleton_method(:body) { response_body }
    payloads = []
    generator = Finance::InsightGenerator.new(user: @user, provider: "openai", consent: true)
    generator.define_singleton_method(:request_response) do |payload|
      payloads << payload
      successful_response
    end
    stub_method(Finance::InsightGenerator, :ai_available?, true) do
      stub_method(Finance::InsightGenerator, :model, "test-model") do
        %w[en zh-CN zh-TW ja ko].each { |locale| I18n.with_locale(locale) { generator.call } }
      end
    end
    assert_equal 5, payloads.length
    ["English", "Simplified Chinese", "Traditional Chinese", "Japanese", "Korean"].each_with_index do |language, index|
      assert_includes payloads[index].fetch(:instructions), language
      assert_includes payloads[index].fetch(:instructions), "Keep the schema keys unchanged"
      assert_equal Finance::InsightGenerator::OUTPUT_SCHEMA, payloads[index].dig(:text, :format, :schema)
    end
    assert_equal content, @user.finance_insights.last.content
  end

  %w[ja ko].each do |locale|
    test "#{locale} CSV and PDF imports keep canonical data and localize errors" do
      get finance_statements_path, params: {locale: locale}
      csv = "Date,Description,Amount,Category\n#{Date.current.iso8601},商户 お店 가게,-25.50,Food & dining\n"
      with_upload(csv, "international.csv", "text/csv") do |file|
        assert_difference "@user.finance_transactions.count", 1 do
          post finance_statements_path, params: {file: file}
        end
      end
      assert_redirected_to finance_transactions_path
      assert_equal "Food & dining", @user.finance_transactions.last.category
      assert_equal "商户 お店 가게", @user.finance_transactions.last.description

      with_upload("Date,Description,Amount\n#{Date.current.iso8601},Invalid,abc\n", "invalid.csv", "text/csv") do |file|
        assert_no_difference "@user.finance_transactions.count" do
          post finance_statements_path, params: {file: file}
        end
      end
      assert_response :unprocessable_entity
      assert_select "html[lang='#{locale}']"
      assert_select "[role='alert']", text: locale == "ja" ? /[\p{Hiragana}\p{Katakana}]/ : /\p{Hangul}/

      clear_pdf = finance_statement_pdf(["Statement Period: 10/01/2025 - 10/31/2025", "10/05 Salary +1,000.00", "10/20 Grocery market -25.50"])
      with_upload(clear_pdf, "international.pdf", "application/pdf") do |file|
        assert_no_difference "@user.finance_statement_drafts.count" do
          assert_difference "@user.finance_transactions.count", 2 do
            post finance_statements_path, params: {file: file}
          end
        end
      end
      assert_redirected_to finance_transactions_path
      follow_redirect!
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_no_match(/translation_missing|Translation missing/, response.body)
    end
  end

  private

  def with_upload(content, filename, type)
    Tempfile.create(["billie-localized", File.extname(filename)]) do |tempfile|
      tempfile.binmode
      tempfile.write(content)
      tempfile.rewind
      yield Rack::Test::UploadedFile.new(tempfile.path, type, original_filename: filename)
    end
  end
end
