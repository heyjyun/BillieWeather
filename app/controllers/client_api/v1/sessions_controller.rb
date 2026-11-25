module ClientApi
  module V1
    # Sign in with an existing BillieWeather account (email + password, plus a
    # two-factor code when the account requires one). Uses Devise's own checks, so
    # failed attempts count toward the usual account lockout.
    class SessionsController < BaseController
      rate_limit to: 10, within: 1.minute, by: -> { request.remote_ip }, only: :create,
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }
      rate_limit to: 30, within: 1.minute, by: -> { request.remote_ip }, only: :revoke_by_digest, name: "revoke",
        with: -> { render json: {error: "rate_limited"}, status: :too_many_requests }
      before_action :authenticate_client!, only: :destroy_others

      def create
        email = params.require(:email).to_s.strip.downcase
        password = params.require(:password).to_s
        user = User.find_by(email: email, platform_agent_of_id: nil)

        unless user&.valid_for_authentication? { user.valid_password?(password) }
          return render json: {error: user&.access_locked? ? "locked" : "invalid_credentials"}, status: :unauthorized
        end
        # Same rule as the website: an account Devise considers inactive (locked, or an unconfirmed
        # email if confirmation is ever required) gets no app token. SessionToken.authenticate
        # enforces this on every later request too; this keeps the first response consistent.
        unless user.active_for_authentication?
          return render json: {error: (user.inactive_message == :unconfirmed) ? "unconfirmed" : "locked"}, status: :unauthorized
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

      # Ends this app's session on the server. Always 204, so a retried or repeated sign-out succeeds
      # and the answer says nothing about whether the token was valid.
      def destroy
        UserSession.revoke_secret(bearer_token, kind: "app")
        head :no_content
      end

      # Finishes a sign-out that was made offline. The app kept only the token's SHA-256 digest, which
      # opens nothing; all it can do is end that one session. Same answer for every input.
      def revoke_by_digest
        UserSession.revoke_digest(params[:token_digest], kind: "app")
        head :no_content
      end

      # "Sign out other sessions": every other app and browser of this account, but not this app.
      def destroy_others
        render json: {revoked: UserSession.revoke_all!(current_user, reason: "signed_out_elsewhere", keep: current_session)}
      end
    end
  end
end
