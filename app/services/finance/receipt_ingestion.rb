module Finance
  # One receipt in, through the unified pipeline (docs/architecture/receipt-capture-and-reconciliation.md §3):
  #
  #   Capture    a photo, screenshot, image or PDF (web upload, the apps, an iOS Shortcut), or text only
  #   Extract    text from the device's OCR / Shortcuts' Live Text, a PDF's text layer, or Finance::LocalOcr
  #   Normalize  ReceiptParser → fields with confidences; a person's confirmed values override them
  #   Deduplicate the same file / receipt number / a re-photographed copy (ReceiptMatcher.duplicate)
  #   Match, Verify, Persist  ReceiptReconciler#process (exact → linked; otherwise suggested or recorded)
  #
  # Idempotent: the same file (SHA-256) or the same client_request_id returns the receipt already
  # stored instead of creating another. Extraction runs before the person's row lock (OCR may be slow);
  # the idempotency check, duplicate check and every write run inside it.
  class ReceiptIngestion
    Result = Data.define(:receipt, :created)
    Invalid = Ledger::Invalid
    MAX_TEXT = 20_000
    MAX_LINES = 400
    PDF_PAGES = 5

    def self.call(**) = new(**).call

    # file: an uploaded file (ActionDispatch::Http::UploadedFile) or {io:/bytes:, filename:, content_type:}.
    # lines: device OCR lines [{text:, confidence:}]; text: plain recognized text (Shortcuts).
    # fields: values a person confirmed (they override the extraction and count as reviewed).
    def initialize(user:, source:, file: nil, lines: nil, text: nil, engine: nil, fields: {}, client_request_id: nil, bank_account_id: nil, actor: "user")
      @user = user
      @source = source.to_s
      @file = file
      @lines = lines
      @text = text
      @engine = engine.to_s.first(60).presence
      @fields = (fields || {}).to_h.stringify_keys.slice(*Receipt::EDITABLE)
      @client_request_id = client_request_id.to_s.strip.first(100).presence
      @bank_account_id = bank_account_id.presence
      @actor = actor
    end

    def call
      raise Invalid, "source_invalid" unless Receipt::SOURCES.include?(@source)
      bytes, filename, content_type = read_file
      raise Invalid, "receipt_empty" if bytes.nil? && @lines.blank? && @text.blank? && @fields.blank?
      sha256 = bytes && Digest::SHA256.hexdigest(bytes)
      if (existing = find_existing(sha256))
        return Result.new(receipt: existing, created: false)
      end
      extraction, engine, ocr_text = extract(bytes, content_type)
      attributes = normalize(extraction).merge(user: @user, source: @source, client_request_id: @client_request_id, filename: filename,
        content_type: content_type, byte_size: bytes&.bytesize, sha256: sha256, extraction_engine: engine, ocr_text: ocr_text&.first(MAX_TEXT))
      apply_fields!(attributes)

      User.find(@user.id).with_lock do
        if (existing = find_existing(sha256))
          next Result.new(receipt: existing, created: false)
        end
        receipt = Receipt.new(attributes)
        duplicate = duplicate_of(receipt)
        if duplicate
          receipt.duplicate_of_id = duplicate[:of]
          receipt.status = (duplicate[:kind] == "possible") ? "possible_duplicate" : "duplicate"
        end
        receipt.file.attach(io: StringIO.new(bytes), filename: filename.presence || "receipt", content_type: content_type) if bytes
        receipt.save!
        AuditEvent.record!(user: @user, action: "create", subject: receipt, actor: @actor, summary: receipt.display_name,
          changes: {"before" => {}, "after" => {"source" => receipt.source, "status" => receipt.status, "engine" => receipt.extraction_engine, "duplicate_of" => receipt.duplicate_of_id}})
        receipt = ReceiptReconciler.new(@user, actor: @actor).process(receipt) unless receipt.duplicate_of_id
        Result.new(receipt: receipt.reload, created: true)
      end
    rescue ActiveRecord::RecordNotUnique
      # A concurrent request with the same file or request id won the race.
      existing = find_existing(sha256)
      raise unless existing
      Result.new(receipt: existing, created: false)
    rescue ActiveRecord::RecordInvalid => error
      raise Invalid, error.record.errors.details.flat_map { |field, details| details.map { |detail| "#{field}_#{detail[:error]}" } }
    end

    private

    def profile = @profile ||= Profile.find_by(user_id: @user.id)

    def find_existing(sha256)
      scope = Receipt.where(user_id: @user.id)
      (@client_request_id && scope.find_by(client_request_id: @client_request_id)) || (sha256 && scope.find_by(sha256: sha256))
    end

    def read_file
      return [nil, nil, nil] if @file.blank?
      if @file.respond_to?(:read)
        bytes = @file.read(Receipt::MAX_BYTES + 1)
        filename = @file.try(:original_filename)
        content_type = @file.try(:content_type)
      else
        file = @file.to_h.symbolize_keys
        bytes = file[:bytes] || file[:io]&.read(Receipt::MAX_BYTES + 1)
        filename = file[:filename]
        content_type = file[:content_type]
      end
      raise Invalid, "file_empty" if bytes.blank?
      raise Invalid, "file_too_large" if bytes.bytesize > Receipt::MAX_BYTES
      content_type = sniff(bytes) || content_type.to_s
      raise Invalid, "file_type" unless Receipt::CONTENT_TYPES.include?(content_type)
      [bytes.b, File.basename(filename.to_s).first(255).presence, content_type]
    end

    # The declared type is not trusted: the first bytes decide.
    def sniff(bytes)
      head = bytes.byteslice(0, 16).to_s.b
      if head.start_with?("%PDF".b) then "application/pdf"
      elsif head.start_with?("\xFF\xD8\xFF".b) then "image/jpeg"
      elsif head.start_with?("\x89PNG".b) then "image/png"
      elsif head.byteslice(0, 4) == "RIFF".b && head.byteslice(8, 4) == "WEBP".b then "image/webp"
      elsif head.byteslice(4, 4) == "ftyp".b && %w[heic heix hevc heim heis mif1 msf1].include?(head.byteslice(8, 4)) then "image/heic"
      end
    end

    # Returns [extraction, engine, recognized text]. Text supplied by the device wins: it came from the
    # person's own on-device OCR and the server does not recognize images itself.
    def extract(bytes, content_type)
      options = {default_currency: profile&.currency, today: Time.current.in_time_zone(@user.time_zone.presence || "America/Chicago").to_date.iso8601}
      if @lines.present?
        lines = Array(@lines).first(MAX_LINES).filter_map do |line|
          line = line.to_h.symbolize_keys
          text = line[:text].to_s.first(500)
          confidence = line[:confidence].nil? ? nil : Float(line[:confidence], exception: false)&.clamp(0.0, 1.0)
          {text: text, confidence: confidence} if text.present?
        end
        return [ReceiptParser.parse(lines, **options), @engine || "device", lines.map { |line| line[:text] }.join("\n")]
      end
      if @text.present?
        text = @text.to_s.first(MAX_TEXT)
        return [ReceiptParser.parse(text, **options), @engine || "device-text", text]
      end
      if bytes && content_type == "application/pdf"
        text = pdf_text(bytes)
        return [ReceiptParser.parse(text, text_confidence: 0.98, **options), "pdf-text", text] if text.present?
      end
      if bytes && (ocr = LocalOcr.recognize(bytes, content_type))
        return [ReceiptParser.parse(ocr[:lines], **options), ocr[:engine], ocr[:lines].map { |line| line[:text] }.join("\n")]
      end
      # No text available: the person fills in the details; nothing is guessed.
      [ReceiptParser.parse([], **options).merge("issues" => ["text_unavailable"]), nil, nil]
    end

    def pdf_text(bytes)
      reader = PDF::Reader.new(StringIO.new(bytes))
      reader.pages.first(PDF_PAGES).map(&:text).join("\n").gsub(/[ \t]{3,}/, "  ").strip.first(MAX_TEXT)
    rescue PDF::Reader::MalformedPDFError, PDF::Reader::UnsupportedFeatureError, PDF::Reader::EncryptedPDFError, ArgumentError
      nil
    end

    def normalize(extraction)
      fields = extraction.fetch("fields")
      value = ->(name) { fields.dig(name, "value") }
      money = ->(name) { value.call(name) && BigDecimal(value.call(name)).abs }
      {
        extraction: extraction, issues: Array(extraction["issues"]), line_items: Array(extraction["lineItems"]).first(200),
        merchant_name: value.call("merchant")&.first(200), purchased_on: value.call("date") && Date.iso8601(value.call("date")),
        purchased_at_time: value.call("time"), total: money.call("total"), subtotal: money.call("subtotal"), tax: money.call("tax"),
        tip: money.call("tip"), discount: money.call("discount"), currency: value.call("currency"), direction: extraction["direction"] || "purchase",
        payment_method: value.call("paymentMethod"), card_last4: value.call("cardLast4"), receipt_number: value.call("receiptNumber")&.first(64),
        confirmed_fields: [], status: "needs_review"
      }
    end

    def apply_fields!(attributes)
      return if @fields.empty? && @bank_account_id.nil?
      cleaned = ReceiptFields.clean(@user, @fields)
      attributes.merge!(cleaned)
      attributes[:confirmed_fields] = (Array(attributes[:confirmed_fields]) | cleaned.keys.map(&:to_s))
      attributes[:reviewed_at] = Time.current if cleaned.any?
      if @bank_account_id
        attributes[:bank_account] = @user.finance_bank_accounts.find_by(id: @bank_account_id) || raise(Invalid, "account_not_found")
      end
    end

    def duplicate_of(receipt)
      return nil if receipt.purchased_on.nil? && receipt.receipt_number.blank?
      scope = Receipt.where(user_id: @user.id).where.not(status: %w[dismissed duplicate possible_duplicate])
      scope = if receipt.purchased_on && receipt.receipt_number.present?
        scope.where(purchased_on: (receipt.purchased_on - 1)..(receipt.purchased_on + 1)).or(scope.where(receipt_number: receipt.receipt_number))
      elsif receipt.purchased_on
        scope.where(purchased_on: (receipt.purchased_on - 1)..(receipt.purchased_on + 1))
      else
        scope.where(receipt_number: receipt.receipt_number)
      end
      ReceiptMatcher.duplicate(shape(receipt), scope.limit(200).map { |other| shape(other) })
    end

    def shape(receipt)
      {id: receipt.id || "incoming", sha256: receipt.sha256, amount_minor: receipt.total_minor, date: receipt.purchased_on&.iso8601, time: receipt.purchased_at_time,
       merchant: receipt.merchant_name, receipt_number: receipt.receipt_number, direction: receipt.direction}
    end
  end
end
