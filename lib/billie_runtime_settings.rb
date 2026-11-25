# frozen_string_literal: true

require "uri"

# Checks the Rails production environment before the server starts (billie:release:check). Names what is
# wrong and never prints a value.
#
# Rollback fence. The releases before server-side sign-ins (UserSession, 2026-11-25) accept signed tokens
# and cookies that can no longer be revoked one by one. They read their signing key from SECRET_KEY_BASE.
# This release reads BILLIE_SECRET_KEY_BASE, so once SECRET_KEY_BASE is gone an accidental rollback cannot
# accept a credential that was signed out. Without SECRET_KEY_BASE Rails falls back to secret_key_base in the
# encrypted credentials, so that must be empty too (or no master key configured). This release cannot know
# whether another value that is still there is the old key, so any value counts as open.
module BillieRuntimeSettings
  KEY = "BILLIE_SECRET_KEY_BASE"
  LEGACY_KEY = "SECRET_KEY_BASE"
  MINIMUM_KEY = 64

  module_function

  # {errors: [...], warnings: [...]}. credentials_key: the readable credentials hold a secret_key_base.
  def review(env, credentials_key: false)
    errors = []
    warnings = []
    key = env[KEY].to_s
    legacy = env[LEGACY_KEY].to_s
    if key.empty? && legacy.empty?
      errors << "#{KEY} is missing"
    elsif (key.empty? ? legacy : key).length < MINIMUM_KEY
      errors << "#{key.empty? ? LEGACY_KEY : KEY} must be at least #{MINIMUM_KEY} characters"
    end
    errors << "SECRET_KEY_BASE_DUMMY is for builds only" unless env["SECRET_KEY_BASE_DUMMY"].to_s.empty?
    errors << "BILLIE_ASSET_BUILD is for builds only" unless env["BILLIE_ASSET_BUILD"].to_s.empty?
    if !legacy.empty?
      warnings << "rollback fence open: an older release would sign with #{LEGACY_KEY}"
    elsif credentials_key
      warnings << "rollback fence open: an older release would sign with secret_key_base from the encrypted credentials"
    end
    errors << "BASE_URL must be an https address" unless https?(env["BASE_URL"].to_s.empty? ? env["RENDER_EXTERNAL_URL"] : env["BASE_URL"])
    half!(env, errors, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
    half!(env, errors, "POSTMARK_API_TOKEN", "MAIL_FROM")
    warnings << "REDIS_URL is missing: sign-in limits are counted per process and forgotten at restart" if env["REDIS_URL"].to_s.empty?
    warnings << "no email delivery is configured: password resets cannot be sent" if env["POSTMARK_API_TOKEN"].to_s.empty? && env["MAILGUN_SMTP_SERVER"].to_s.empty?
    {errors: errors, warnings: warnings}
  end

  def verify!(env = ENV, credentials_key: false)
    found = review(env, credentials_key: credentials_key)
    found[:warnings].each { |text| warn "Settings warning: #{text}" }
    raise "Unsafe production settings: #{found[:errors].join("; ")}" if found[:errors].any?
  end

  def https?(value)
    uri = URI.parse(value.to_s)
    uri.is_a?(URI::HTTPS) && !uri.host.to_s.empty?
  rescue URI::InvalidURIError
    false
  end

  def half!(env, errors, first, second)
    present = [first, second].reject { |name| env[name].to_s.strip.empty? }
    errors << "#{([first, second] - present).first} is missing while #{present.first} is set" if present.size == 1
  end
end
