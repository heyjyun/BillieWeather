module ClientApi
  module V1
    # Sign in with an existing BillieWeather account (email + password, plus a
    # two-factor code when the account requires one). Uses Devise's own checks, so
    # failed attempts count toward the usual account lockout.
    class SessionsController < BaseController
      rate_limit to: 10, within: 1.minute, by: -> { request.remote_ip }, only: :create,
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }

      def create
        email = params.require(:email).to_s.strip.downcase
        password = params.require(:password).to_s
        user = User.find_by(email: email, platform_agent_of_id: nil)

        unless user&.valid_for_authentication? { user.valid_password?(password) }
          return render json: {error: user&.access_locked? ? "locked" : "invalid_credentials"}, status: :unauthorized
        end
        if user.respond_to?(:otp_required_for_login) && user.otp_required_for_login
          code = params[:otp_attempt].to_s.strip
          return render json: {error: "otp_required"}, status: :unauthorized if code.empty?
          valid = user.validate_and_consume_otp!(code) || (user.respond_to?(:invalidate_otp_backup_code!) && user.invalidate_otp_backup_code!(code))
          return render json: {error: record_failed_otp(user) ? "locked" : "invalid_otp"}, status: :unauthorized unless valid
        end

        user.reset_failed_attempts! # a complete sign-in, as on the website
        token, expires_at = ClientApi::SessionToken.issue(user)
        user.update_columns(last_seen_at: Time.current)
        render json: {token: token, expires_at: expires_at.iso8601, account: account_json(user)}, status: :created
      end

      # A wrong two-factor code counts toward the same lockout as a wrong password, so knowing
      # the password does not allow unlimited code guesses. Returns whether the account is now locked.
      private def record_failed_otp(user)
        user.increment_failed_attempts
        user.lock_access! if user.failed_attempts >= User.maximum_attempts && !user.access_locked?
        user.access_locked?
      end

      # Tokens are stateless; the app forgets its token. Changing the password signs out every app.
      def destroy
        head :no_content
      end
    end
  end
end
