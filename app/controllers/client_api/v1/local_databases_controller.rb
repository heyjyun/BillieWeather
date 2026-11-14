module ClientApi
  module V1
    # The apps tell the server basic facts about their LOCAL databases so the person can see
    # them on the website: a name, a size, a few counts. Strictly one-way and allowlisted:
    # no statement names, no transactions, no amounts, no balances, no paths, no files.
    # Every operation is scoped to the authenticated account and is idempotent.
    class LocalDatabasesController < BaseController
      before_action :authenticate_client!
      before_action :require_valid_ids
      rate_limit to: 120, within: 1.minute, by: -> { request.remote_ip },
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      INTEGER_FIELDS = %w[size_bytes statement_count transaction_count rule_count].freeze

      def upsert
        payload = params.permit!.to_h.fetch("database", nil)
        return render json: {error: "bad_request"}, status: :bad_request unless payload.is_a?(Hash)
        unexpected = payload.keys - Finance::LocalDatabaseReport::ALLOWED_FIELDS
        return render json: {error: "unexpected_fields", fields: unexpected}, status: :unprocessable_entity if unexpected.any?
        # Only current apps (stable device id kept next to the SQLite files) say which platform
        # they run on. Anything else is an incomplete identity: refused, never stored, so a
        # browser preview or an old build cannot add "Unnamed database" cards.
        unless Finance::LocalDevice::PLATFORMS.include?(payload["platform"])
          return render json: {error: "incomplete_identity"}, status: :unprocessable_entity
        end

        attributes = parse(payload)
        return render json: {error: "invalid"}, status: :unprocessable_entity unless attributes
        sequence = attributes.delete(:sequence)
        status = Finance::LocalDatabaseReport.apply!(user: current_user, device_id: params[:device_id], database_id: params[:database_id],
          attributes: attributes, sequence: sequence)
        render json: {status: status}
      rescue ActiveRecord::RecordInvalid
        render json: {error: "invalid"}, status: :unprocessable_entity
      end

      def destroy
        sequence = parse_sequence(params[:sequence])
        return render json: {error: "invalid"}, status: :unprocessable_entity unless sequence
        status = Finance::LocalDatabaseReport.apply!(user: current_user, device_id: params[:device_id], database_id: params[:database_id], sequence: sequence)
        render json: {status: status}
      end

      # "Stop showing my local databases": forgets everything this device reported.
      def purge
        sequence = parse_sequence(params[:sequence])
        return render json: {error: "invalid"}, status: :unprocessable_entity unless sequence
        render json: {status: Finance::LocalDatabaseReport.purge_device!(user: current_user, device_id: params[:device_id], sequence: sequence)}
      end

      private

      def require_valid_ids
        ids = [params[:device_id], params[:database_id]].compact
        render json: {error: "invalid"}, status: :unprocessable_entity unless ids.all? { |id| id.to_s.match?(Finance::LocalDevice::UUID) }
      end

      def parse_sequence(value)
        number = Integer(value.to_s, exception: false)
        number if number&.positive? && number < 2**62
      end

      # Returns clean attributes, or nil if anything is missing or malformed.
      def parse(payload)
        sequence = parse_sequence(payload["sequence"])
        name = clean_text(payload["name"], 60)
        device_name = clean_text(payload["device_name"], 80)
        return nil unless sequence && name && device_name
        numbers = INTEGER_FIELDS.to_h { |field| [field, payload[field]] }
        return nil unless numbers.values.all? { |value| value.is_a?(Integer) && value >= 0 }
        period_start = parse_date(payload["period_start"])
        period_end = parse_date(payload["period_end"])
        modified_at = parse_time(payload["modified_at"])
        opened_at = parse_time(payload["opened_at"])
        synced_at = parse_time(payload["synced_at"])
        return nil if [period_start, period_end, modified_at, opened_at, synced_at].include?(:bad)
        {name: name, device_name: device_name, platform: payload["platform"], sequence: sequence, period_start: period_start, period_end: period_end,
         modified_at: modified_at, opened_at: opened_at, synced_at: synced_at}.merge(numbers.symbolize_keys)
      end

      # Control characters out, whitespace squeezed; nil if empty or too long.
      def clean_text(value, max)
        return nil unless value.is_a?(String)
        text = value.gsub(/[[:cntrl:]]/, "").squish
        text if text.present? && text.length <= max
      end

      def parse_date(value)
        return nil if value.nil?
        value.is_a?(String) ? Date.iso8601(value) : :bad
      rescue Date::Error
        :bad
      end

      def parse_time(value)
        return nil if value.nil?
        return :bad unless value.is_a?(String)
        time = Time.iso8601(value)
        # A device clock far in the future would sort wrongly; the server records its own time separately.
        (time > 1.day.from_now) ? :bad : time
      rescue ArgumentError
        :bad
      end
    end
  end
end
