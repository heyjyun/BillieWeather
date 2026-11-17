module ClientApi
  module V1
    # Receipt capture for the apps and for iOS Shortcuts / Siri.
    #
    #   POST /api/client/v1/finance/receipts     one receipt (JSON with base64 file, or multipart form)
    #   GET  /api/client/v1/finance/receipts/:id the receipt's status, verification and match
    #
    # Authorization: the app's bearer session (ClientApi::SessionToken) or a receipt-only capture token
    # (Finance::CaptureToken, "bwc_…") that a person created for a Shortcut. A capture token can do
    # nothing else in the API. Text is recognized on the phone (the app's OCR, or Shortcuts' "Extract
    # Text from Image"); the server parses it and runs the same pipeline as the website. Retries with the
    # same client_request_id (or the same file) return the stored receipt instead of adding another.
    class ReceiptsController < BaseController
      MAX_BASE64 = (Finance::Receipt::MAX_BYTES * 4 / 3) + 16

      before_action :authenticate_capture!
      rate_limit to: 30, within: 1.minute, by: -> { request.remote_ip },
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      def create
        payload = params[:receipt].presence || params
        result = Finance::ReceiptIngestion.call(user: current_user, source: source(payload), file: file_from(payload), lines: lines_from(payload),
          text: payload[:text].presence&.to_s, engine: payload[:engine].presence&.to_s, fields: fields_from(payload),
          client_request_id: payload[:client_request_id].presence&.to_s)
        render json: {created: result.created, receipt: receipt_json(result.receipt)}, status: result.created ? :created : :ok
      rescue Finance::Ledger::Invalid => error
        render json: {error: "invalid", codes: error.codes}, status: :unprocessable_entity
      end

      def show
        receipt = Finance::Receipt.where(user_id: current_user.id).find_by(id: params[:id])
        return render json: {error: "not_found"}, status: :not_found unless receipt
        render json: {receipt: receipt_json(receipt)}
      end

      private

      def authenticate_capture!
        token = request.authorization.to_s[/\ABearer (.+)\z/, 1].to_s
        @current_user = token.start_with?(Finance::CaptureToken::PREFIX) ? Finance::CaptureToken.authenticate(token) : ClientApi::SessionToken.authenticate(token)
        @via_shortcut = token.start_with?(Finance::CaptureToken::PREFIX)
        return render json: {error: "unauthorized"}, status: :unauthorized unless @current_user
        render json: {error: "usage_region_required"}, status: :forbidden if @current_user.respond_to?(:usage_region_pending?) && @current_user.usage_region_pending?
      end

      def source(payload)
        return "shortcut" if @via_shortcut
        payload[:source].to_s.presence_in(%w[camera upload]) || "app"
      end

      def file_from(payload)
        if payload[:file].respond_to?(:read)
          payload[:file]
        elsif payload[:file_base64].present?
          encoded = payload[:file_base64].to_s
          raise Finance::Ledger::Invalid, "file_too_large" if encoded.bytesize > MAX_BASE64
          bytes = Base64.strict_decode64(encoded.gsub(/\s+/, ""))
          {bytes: bytes, filename: payload[:filename].to_s.presence || "receipt", content_type: payload[:content_type].to_s}
        end
      rescue ArgumentError
        raise Finance::Ledger::Invalid, "file_invalid"
      end

      def lines_from(payload)
        lines = payload[:lines]
        return nil if lines.blank?
        Array(lines).first(Finance::ReceiptIngestion::MAX_LINES).map do |line|
          line = line.respond_to?(:permit) ? line.permit(:text, :confidence).to_h : line.to_h
          {text: line["text"] || line[:text], confidence: line["confidence"] || line[:confidence]}
        end
      end

      # Values the person confirmed in the app. A Shortcut sends text only: nothing is "confirmed".
      def fields_from(payload)
        return {} if @via_shortcut || payload[:fields].blank?
        raw = payload[:fields].respond_to?(:permit) ? payload[:fields].permit(:merchant, :date, :time, :total, :subtotal, :tax, :tip, :discount, :currency,
          :direction, :payment_method, :card_last4, :receipt_number, :category).to_h : payload[:fields].to_h
        raw = raw.stringify_keys
        {
          "merchant_name" => raw["merchant"], "purchased_on" => raw["date"], "purchased_at_time" => raw["time"], "total" => raw["total"], "subtotal" => raw["subtotal"],
          "tax" => raw["tax"], "tip" => raw["tip"], "discount" => raw["discount"], "currency" => raw["currency"], "direction" => raw["direction"],
          "payment_method" => raw["payment_method"], "card_last4" => raw["card_last4"], "receipt_number" => raw["receipt_number"], "category" => raw["category"]
        }.select { |column, _| raw.key?(api_name(column)) }
      end

      def api_name(column)
        {"merchant_name" => "merchant", "purchased_on" => "date", "purchased_at_time" => "time"}.fetch(column, column)
      end

      def receipt_json(receipt)
        receipt = Finance::Receipt.includes(matches: :finance_transaction).find(receipt.id)
        confirmed = receipt.confirmed_matches
        best = confirmed.first || receipt.suggested_matches.max_by(&:score)
        {
          id: receipt.id, uuid: receipt.uuid, status: receipt.status, verification: receipt.verification, source: receipt.source,
          merchant: receipt.merchant_name, date: receipt.purchased_on&.iso8601, time: receipt.purchased_at_time,
          total: receipt.total&.to_s("F"), currency: receipt.currency, direction: receipt.direction, issues: receipt.issues,
          duplicate_of: receipt.duplicate_of_id, recorded_transaction_id: receipt.transaction_id,
          match: best && {
            level: best.level, status: best.status, decided_by: best.decided_by, reasons: best.reason_codes,
            transaction: {id: best.transaction_id, booked_on: best.finance_transaction.booked_on.iso8601, description: best.finance_transaction.original_description,
                          amount: best.finance_transaction.amount.to_s("F")}
          },
          url: Rails.application.routes.url_helpers.finance_receipt_url(receipt, host: request.host_with_port, protocol: request.protocol)
        }
      end
    end
  end
end
