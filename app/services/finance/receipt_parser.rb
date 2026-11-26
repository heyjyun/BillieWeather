module Finance
  # Port of packages/finance-core/src/receipt/parse.ts: recognized receipt text → fields with a
  # confidence each. Both sides replay packages/finance-core/fixtures/receipts/parse-cases.json
  # (test/services/finance/receipt_contract_test.rb), so keep the two in step.
  #
  # The server never recognizes images itself and never sends them anywhere: text comes from the
  # device (app OCR, iOS Shortcuts "Extract Text from Image"), a PDF's text layer, or an optional
  # local OCR command (Finance::LocalOcr). A field that cannot be read is nil with confidence 0.
  #
  # Result (string keys, the same shape the TypeScript returns, fields nested under "fields"):
  #   {"version" => 1, "fields" => {"merchant" => {"value", "confidence", "line"}, ...},
  #    "direction" => "purchase"|"refund", "lineItems" => [...], "issues" => [...]}
  module ReceiptParser
    CONFIDENT = 0.8
    FIELDS = %w[merchant date time currency total subtotal tax tip discount paymentMethod cardLast4 receiptNumber].freeze
    BLOCKING_ISSUES = %w[multiple_totals totals_inconsistent date_ambiguous future_date total_inferred].freeze
    # Receipt columns ↔ extraction field names.
    FIELD_FOR_COLUMN = {
      "merchant_name" => "merchant", "purchased_on" => "date", "purchased_at_time" => "time", "currency" => "currency", "total" => "total",
      "subtotal" => "subtotal", "tax" => "tax", "tip" => "tip", "discount" => "discount", "payment_method" => "paymentMethod",
      "card_last4" => "cardLast4", "receipt_number" => "receiptNumber"
    }.freeze

    R = JsRegexp

    SYMBOLS = [
      [R[/US\$/i], "USD"], [R[/C\$|CA\$/i], "CAD"], [R[/A\$|AU\$/i], "AUD"], [R[/HK\$/i], "HKD"], [R[/NT\$/i], "TWD"], [R[/S\$/i], "SGD"], [R[/MX\$/i], "MXN"],
      [/€/, "EUR"], [/£/, "GBP"], [/₩|원/, "KRW"], [/₹/, "INR"], [/円/, "JPY"], [/元|人民币|RMB/i, "CNY"]
    ].freeze
    CODES = R[/\b(USD|EUR|GBP|JPY|CNY|CAD|AUD|KRW|INR|MXN|CHF|HKD|TWD|SGD|NZD|SEK|NOK|DKK)\b/]

    DECIMAL_AMOUNT = R[/(?<![\d.,])(\()?(-\s?)?(?:[$€£¥₩₹]\s?)?(\d{1,3}(?:[.,]\d{3})+|\d+)([.,])(\d{2})(?![\d%])(?![.,]\d)(?!\s?%)\s?(-|\)|CR\b)?/i]
    WHOLE_AMOUNT = /(?:[¥₩]\s?(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]))|(?:(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\s?(?:円|원|元)(?!\d))/

    TOTAL_STRONG = R[/\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*to\s*pay|total\s*paid|amount\s*paid|total\s*charged|total\s*amount|importe\s*total|total\s*a\s*pagar|montant\s*total|gesamtbetrag|zu\s*zahlen)\b|合计|合計|总计|總計|应付|應付|实付|實付|お会計|合計金額|총액|합계|결제\s*금액/i]
    TOTAL_PLAIN = R[/\b(total|amount|summe|gesamt|montant|importe)\b/i]
    NOT_TOTAL = R[/sub\s*-?\s*total|total\s*(tax|savings?|saved|discount|items?|qty|quantity|count|number|tips?)\b|tax\s*total|items?\s*total|小计|小計|before\s*tip|pre-?\s*tip/i]
    SUBTOTAL = /sub\s*-?\s*total|zwischensumme|sous-?\s*total|小计|小計|소계/i
    TAX = R[/\b(sales\s*tax|tax|vat|gst|hst|pst|qst|iva|mwst|tva|ust)\b|消費税|税额|稅額|税金|부가세|세금/i]
    TIP = R[/\b(tip|tips|gratuity|propina|pourboire|trinkgeld)\b|小费|小費|チップ|팁|봉사료/i]
    DISCOUNT = R[/\b(discount|savings|you\s*saved|coupon|promo|promotion|markdown|descuento|rabatt|remise)\b|折扣|优惠|優惠|割引|할인/i]
    CHANGE = R[/\b(change|change\s*due)\b|找零|お釣り|おつり|거스름/i]
    CASH = R[/\b(cash|efectivo|bar|esp[eè]ces)\b|现金|現金|현금/i]
    CARD = R[/\b(visa|mastercard|master\s*card|amex|american\s*express|discover|debit|credit|card|chip|contactless|tarjeta|carte|karte|ec-karte)\b|刷卡|信用卡|银行卡|銀行卡|カード|카드/i]
    MOBILE = R[/\b(apple\s*pay|google\s*pay|samsung\s*pay|paypal|venmo|alipay|wechat\s*pay)\b|支付宝|支付寶|微信支付/i]
    LAST4 = R[/(?:\*{2,}|x{3,}|\#{2,}|ending\s*(?:in)?\s*|acct\s*[:#]?\s*\**|account\s*[:#]?\s*\**)\s*(\d{4})\b/i]
    RECEIPT_NO = R[/\b(?:receipt|rcpt|invoice|inv|order|trans(?:action)?|trx|txn|ticket|chk|ref(?:erence)?)\s*(?:no\.?|number|num|#|id)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,})\b|(?:单号|單號|伝票番号|영수증\s*번호)\s*[:：]?\s*([A-Z0-9-]{4,})/i]
    REFUND = R[/\b(refund|refunded|return|returned|credit\s*memo|reembolso|devoluci[oó]n|remboursement|erstattung)\b|退款|退货|退貨|返品|返金|환불/i]
    REFUND_POLICY = R[/\b(policy|within|days|accepted|receipt\s*required|eligible|exchange)\b/i]
    STARS = /\*{2,}|x{3,}/i

    SKIP_HEADER = /\A(welcome|thank\s*you|thanks|please|come\s*again|have\s*a|visit\s*us|receipt|sales\s*receipt|customer\s*copy|merchant\s*copy|order|invoice|tel|phone|fax|www\.|http|store\s*#|store\s*no|cashier|server|register|terminal|table|guest)/i
    ADDRESS = R[/\A\d+\s+\S+.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|suite|ste|plaza|sq|square|ct|court|pl|place)\b\.?/i]
    PHONE = R[/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/]
    CITY_ZIP = R[/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/]
    EMAIL_URL = R[/@|\bwww\.|https?:|\.com\b/i]

    MONTHS = {"jan" => 1, "feb" => 2, "mar" => 3, "apr" => 4, "may" => 5, "jun" => 6, "jul" => 7, "aug" => 8, "sep" => 9, "sept" => 9, "oct" => 10, "nov" => 11, "dec" => 12}.freeze
    MONTH_NAMES = "jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec"
    ISO_DATE = R[/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/]
    CJK_DATE = /(20\d{2})\s*[年\/]\s*(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?/
    DAY_MONTH_NAME = R[Regexp.new("\\b(\\d{1,2})[\\s-](#{MONTH_NAMES})[a-z]*\\.?[,\\s-]+(\\d{4}|\\d{2})(?![:\\d])", Regexp::IGNORECASE)]
    MONTH_NAME_DAY = R[Regexp.new("\\b(#{MONTH_NAMES})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}|\\d{2})(?![:\\d])", Regexp::IGNORECASE)]
    NUMERIC_DATE = /(?<![\d.])(\d{1,2})([\/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/
    TIME = R[/\b([01]?\d|2[0-3])[:：]([0-5]\d)(?::[0-5]\d)?\s*([ap]\.?m\.?)?(?!\d)/i]
    DATE_LABEL = R[/\b(date|fecha|datum|日期|日付|날짜)\b/i]

    Token = Data.define(:minor, :index, :negative)
    Labeled = Data.define(:index, :minor, :confidence, :negative)

    module_function

    def round2(value) = (value * 100).round / 100.0

    def empty = {"value" => nil, "confidence" => 0, "line" => nil}

    def field(value, confidence, line) = {"value" => value, "confidence" => round2(confidence.clamp(0, 1).to_f), "line" => line}

    def format_minor(minor)
      sign = minor.negative? ? "-" : ""
      "#{sign}#{minor.abs / 100}.#{(minor.abs % 100).to_s.rjust(2, "0")}"
    end

    def parse_minor(value)
      match = value.to_s.strip.match(/\A(-)?(\d+)(?:\.(\d{1,2}))?\z/)
      return nil unless match
      (match[1] ? -1 : 1) * (match[2].to_i * 100 + match[3].to_s.ljust(2, "0").to_i)
    end

    def matches(text, regexp) = text.to_enum(:scan, regexp).map { Regexp.last_match }

    def amounts_in(text)
      tokens = matches(text, DECIMAL_AMOUNT).filter_map do |match|
        whole = match[3].delete(".,")
        next if whole.length > 11
        Token.new(minor: whole.to_i * 100 + match[5].to_i, index: match.begin(0), negative: !!(match[1] || match[2] || match[6]))
      end
      if tokens.empty?
        tokens = matches(text, WHOLE_AMOUNT).filter_map do |match|
          whole = (match[1] || match[2]).delete(",")
          next if whole.length > 11
          Token.new(minor: whole.to_i * 100, index: match.begin(0), negative: false)
        end
      end
      tokens
    end

    def valid_date(year, month, day)
      return nil unless Date.valid_date?(year, month, day)
      format("%04d-%02d-%02d", year, month, day)
    end

    def full_year(text) = (text.length == 2) ? 2000 + text.to_i : text.to_i

    def month_number(name)
      lower = name.downcase
      MONTHS.fetch(lower[0, lower.start_with?("sept") ? 4 : 3], 0)
    end

    def date_in(text, order)
      if (match = text.match(ISO_DATE) || text.match(CJK_DATE))
        value = valid_date(match[1].to_i, match[2].to_i, match[3].to_i)
        return [value, 1, false] if value
      end
      if (match = text.match(DAY_MONTH_NAME))
        value = valid_date(full_year(match[3]), month_number(match[2]), match[1].to_i)
        return [value, 1, false] if value
      end
      if (match = text.match(MONTH_NAME_DAY))
        value = valid_date(full_year(match[3]), month_number(match[1]), match[2].to_i)
        return [value, 1, false] if value
      end
      if (match = text.match(NUMERIC_DATE))
        first = match[1].to_i
        second = match[3].to_i
        year = full_year(match[4])
        if first > 12 && second <= 12
          value = valid_date(year, second, first)
          return [value, 1, false] if value
        elsif second > 12 && first <= 12
          value = valid_date(year, first, second)
          return [value, 1, false] if value
        elsif first == second
          value = valid_date(year, first, second)
          return [value, 1, false] if value
        else
          chosen = order || "mdy"
          value = (chosen == "mdy") ? valid_date(year, first, second) : valid_date(year, second, first)
          return [value, order ? 0.95 : 0.5, !order] if value
        end
      end
      nil
    end

    def time_in(text)
      match = text.match(TIME)
      return nil unless match
      hour = match[1].to_i
      meridiem = match[3]&.downcase&.delete(".")
      hour += 12 if meridiem == "pm" && hour < 12
      hour = 0 if meridiem == "am" && hour == 12
      format("%02d:%s", hour, match[2])
    end

    def letter_count(text) = text.gsub(/[^\p{L}]/, "").length

    # `input`: an Array of {text:, confidence:} (or "text"/"confidence") or one String.
    def parse(input, default_currency: nil, today: nil, date_order: nil, text_confidence: 0.9)
      raw = input.is_a?(String) ? input.split(/\r?\n/).map { |text| {text: text, confidence: nil} } : Array(input)
      lines = raw.map do |line|
        line = line.to_h.transform_keys(&:to_sym)
        {text: line[:text].to_s.unicode_normalize(:nfkc).gsub(/[[:space:]]+/, " ").strip, confidence: line[:confidence]&.to_f}
      end
      confidence_of = ->(index) { lines[index][:confidence] || text_confidence }
      issues = Set.new

      currency = empty
      all_text = lines.map { |line| line[:text] }.join("\n")
      if (code = all_text.match(CODES))
        currency = field(code[1].upcase, 0.95, nil)
      else
        SYMBOLS.each do |pattern, iso|
          if all_text.match?(pattern)
            currency = field(iso, 0.9, nil)
            break
          end
        end
        if currency["value"].nil? && all_text.match?(/¥|￥/)
          iso = if all_text.match?(/[぀-ヿ]/)
            "JPY"
          else
            (all_text.match?(/[一-鿿]/) ? "CNY" : "JPY")
          end
          currency = field(iso, 0.7, nil)
        end
        if currency["value"].nil? && default_currency.present?
          currency = field(default_currency.to_s.upcase, all_text.include?("$") ? 0.8 : 0.6, nil)
          issues << "currency_assumed"
        end
      end

      totals = []
      strong_totals = []
      subtotal = empty
      tax_minor = 0
      tax_line = nil
      tax_confidence = 1
      tip = empty
      discount_minor = 0
      discount_line = nil
      discount_confidence = 1
      payment = empty
      last4 = empty
      receipt_number = empty
      refund_signal = false
      tender_minor = []
      first_summary_line = lines.length
      amount_lines = []

      lines.each_with_index do |line, index|
        text = line[:text]
        next if text.empty?
        tokens = amounts_in(text)
        label_only = tokens.empty? && index + 1 < lines.length && amounts_in(lines[index + 1][:text]).any? && letter_count(lines[index + 1][:text]).zero?
        tokens = amounts_in(lines[index + 1][:text]) if label_only
        confidence = confidence_of.call(index)
        last = tokens.last
        amount_lines << [index, tokens] if tokens.any?

        if last4["value"].nil? && (card = text.match(LAST4)) && (text.match?(CARD) || text.match?(MOBILE) || text.match?(STARS))
          last4 = field(card[1], confidence, index)
        end
        if receipt_number["value"].nil? && (number = text.match(RECEIPT_NO))
          id = number[1] || number[2]
          receipt_number = field(id.upcase, confidence * 0.95, index) if id&.match?(/\d/) && !text.match?(LAST4)
        end
        if text.match?(MOBILE)
          payment = field("mobile", confidence, index) unless payment["value"] == "mobile"
        elsif text.match?(CARD) && (last || text.match?(LAST4)) && payment["value"].nil?
          payment = field("card", confidence, index)
        elsif text.match?(CASH) && last && !text.match?(CHANGE) && payment["value"].nil?
          payment = field("cash", confidence, index)
        end
        refund_signal = true if text.match?(REFUND) && !text.match?(REFUND_POLICY) && last
        next unless last

        if text.match?(SUBTOTAL)
          subtotal = field(format_minor(last.minor), confidence, index) if subtotal["value"].nil?
          first_summary_line = [first_summary_line, index].min
        elsif text.match?(TIP) && !text.match?(TOTAL_STRONG)
          tip = field(format_minor(last.minor), confidence, index)
          first_summary_line = [first_summary_line, index].min
        elsif text.match?(TAX) && !text.match?(TOTAL_STRONG) && !text.match?(R[/\b(incl|included|inkl)\b/i])
          tax_minor += last.minor
          tax_line ||= index
          tax_confidence = [tax_confidence, confidence].min
          first_summary_line = [first_summary_line, index].min
        elsif text.match?(DISCOUNT) && !text.match?(TOTAL_STRONG)
          discount_minor += last.minor
          discount_line ||= index
          discount_confidence = [discount_confidence, confidence].min
        elsif !text.match?(NOT_TOTAL) && (text.match?(TOTAL_STRONG) || text.match?(TOTAL_PLAIN))
          entry = Labeled.new(index: index, minor: last.minor, confidence: confidence, negative: last.negative)
          totals << entry
          strong_totals << entry if text.match?(TOTAL_STRONG)
          first_summary_line = [first_summary_line, index].min
        elsif (text.match?(CARD) || text.match?(CASH) || text.match?(MOBILE)) && !text.match?(CHANGE)
          tender_minor << last.minor
          first_summary_line = [first_summary_line, index].min
        end
      end

      positive = ->(entries) { (entries.any? { |entry| entry.minor.positive? }) ? entries.select { |entry| entry.minor.positive? } : entries }
      pool = (positive.call(strong_totals).any? && strong_totals.any? { |entry| entry.minor.positive? }) ? positive.call(strong_totals) : positive.call(totals)
      total = empty
      total_negative = false
      if pool.any?
        chosen = pool.last
        distinct = pool.map(&:minor).uniq
        confidence = chosen.confidence * (strong_totals.any? ? 1 : 0.95)
        if distinct.length > 1
          tip_minor = parse_minor(tip["value"])
          explained = !tip_minor.nil? && distinct.any? { |value| value + tip_minor == chosen.minor }
          unless explained
            issues << "multiple_totals"
            confidence *= 0.7
          end
        end
        total = field(format_minor(chosen.minor), confidence, chosen.index)
        total_negative = chosen.negative
      elsif amount_lines.any?
        best_index = amount_lines.first[0]
        best_minor = -1
        amount_lines.each do |index, tokens|
          tokens.each do |token|
            if token.minor > best_minor
              best_minor = token.minor
              best_index = index
            end
          end
        end
        total = field(format_minor(best_minor), confidence_of.call(best_index) * 0.4, best_index)
        issues << "total_inferred"
      else
        issues << "total_missing"
      end

      tax = tax_line.nil? ? empty : field(format_minor(tax_minor), tax_confidence, tax_line)
      discount = discount_line.nil? ? empty : field(format_minor(discount_minor), discount_confidence, discount_line)

      total_minor = parse_minor(total["value"])
      subtotal_minor = parse_minor(subtotal["value"])
      if total_minor && subtotal_minor
        tip_minor = parse_minor(tip["value"]) || 0
        candidates = [subtotal_minor + tax_minor + tip_minor - discount_minor, subtotal_minor + tax_minor + tip_minor, subtotal_minor + tax_minor - discount_minor, subtotal_minor + tax_minor]
        total = if candidates.include?(total_minor)
          boosted = [0.98, total["confidence"] + 0.1].min
          field(total["value"], [total["confidence"], boosted].max, total["line"])
        else
          issues << "totals_inconsistent"
          field(total["value"], total["confidence"] * 0.6, total["line"])
        end
      end
      if total_minor && tender_minor.include?(total_minor) && !issues.include?("totals_inconsistent")
        total = field(total["value"], [0.99, total["confidence"] + 0.05].min, total["line"])
      end

      merchant = empty
      [lines.length, 8].min.times do |index|
        text = lines[index][:text].sub(/\Awelcome\s+to\s+/i, "")
        next if letter_count(text) < 2
        next if text.match?(SKIP_HEADER) || text.match?(ADDRESS) || text.match?(PHONE) || text.match?(CITY_ZIP) || text.match?(EMAIL_URL)
        next if date_in(text, nil) || amounts_in(text).any?
        next if text.match?(TOTAL_PLAIN) || text.match?(TAX)
        name = text.sub(/\s*#\s*\d+\s*\z/, "").sub(/\s+store\s+\d+\z/i, "").strip
        merchant = field(name, confidence_of.call(index) * 0.9, index)
        break
      end
      issues << "merchant_missing" if merchant["value"].nil?

      date = empty
      time = empty
      ordered = lines.each_with_index.sort_by { |line, index| [line[:text].match?(DATE_LABEL) ? 0 : 1, index] }
      ordered.each do |line, index|
        hit = date_in(line[:text], date_order)
        next unless hit
        value, certainty, ambiguous = hit
        date = field(value, confidence_of.call(index) * certainty, index)
        issues << "date_ambiguous" if ambiguous
        same_line_time = time_in(line[:text].sub(ISO_DATE, " ").sub(NUMERIC_DATE, " "))
        time = field(same_line_time, confidence_of.call(index), index) if same_line_time
        break
      end
      if time["value"].nil?
        lines.each_with_index do |line, index|
          found = time_in(line[:text])
          next unless found
          time = field(found, confidence_of.call(index) * 0.9, index)
          break
        end
      end
      if date["value"].nil?
        issues << "date_missing"
      elsif today.present? && Date.iso8601(date["value"]) > Date.iso8601(today.to_s) + 1
        issues << "future_date"
        date = field(date["value"], [date["confidence"], 0.3].min, date["line"])
      end

      line_items = []
      amount_lines.each do |index, tokens|
        next if index >= first_summary_line || index == merchant["line"]
        text = lines[index][:text]
        next if [TOTAL_PLAIN, TAX, TIP, DISCOUNT, CHANGE, CARD, CASH, DATE_LABEL].any? { |pattern| text.match?(pattern) }
        description = text[0, tokens.first.index].sub(/\s+(\d+\s*(?:x|@|×))\s*\z/i, "").sub(/\A\d+\s*(?:x|@|×)\s*/i, "").strip
        next if letter_count(description) < 2
        quantity_match = text.match(/(?:\A|\s)(\d{1,3})\s*(?:x|@|×)\s*/i) || text.match(R[/\bqty\s*[:.]?\s*(\d{1,3})\b/i])
        quantity = quantity_match&.[](1)
        amount = tokens.last
        unit = if tokens.length >= 2 then tokens[-2].minor
        elsif quantity&.to_i&.positive? && (amount.minor % quantity.to_i).zero? then amount.minor / quantity.to_i
        end
        line_items << {
          "description" => description.gsub(/\s+/, " "), "quantity" => quantity, "unitPrice" => unit && format_minor(unit),
          "amount" => format_minor(amount.negative ? -amount.minor : amount.minor), "confidence" => round2(confidence_of.call(index) * 0.9), "line" => index
        }
      end

      refund_total = totals.any? { |entry| entry.negative || lines[entry.index][:text].match?(REFUND) }
      direction = (total_negative || (refund_signal && refund_total) || (refund_signal && pool.empty?)) ? "refund" : "purchase"
      issues << "low_confidence" if [merchant, date, total].any? { |key| !key["value"].nil? && key["confidence"] < 0.6 }

      {
        "version" => 1,
        "fields" => {
          "merchant" => merchant, "date" => date, "time" => time, "currency" => currency, "total" => total, "subtotal" => subtotal, "tax" => tax,
          "tip" => tip, "discount" => discount, "paymentMethod" => payment, "cardLast4" => last4, "receiptNumber" => receipt_number
        },
        "direction" => direction, "lineItems" => line_items, "issues" => issues.to_a.sort
      }
    end

    def confident?(extraction)
      fields = extraction.fetch("fields")
      %w[merchant date total].all? { |key| !fields.dig(key, "value").nil? && fields.dig(key, "confidence").to_f >= CONFIDENT } &&
        (BLOCKING_ISSUES & Array(extraction["issues"])).empty?
    end
  end
end
