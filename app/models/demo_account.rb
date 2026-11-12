# The public Example Account: one shared, read-only login backed only by synthetic data.
#
# The account is identified by a reserved address in the `.invalid` top-level domain
# (RFC 2606), which no mailbox and no Google account can ever have, and which nobody can
# register or switch to (see User#reserved_demo_email). It has no usable password: the
# only way in is DemoSessionsController, which signs it in on the server.
#
# It does not exist until an operator runs `bin/rails billie:demo:seed`; until then the
# "Try Example Account" button is hidden. Set BILLIE_DEMO_ENABLED=false to hide it again
# without deleting anything.
module DemoAccount
  EMAIL = "example@demo.billieweather.invalid"
  DOMAIN = "demo.billieweather.invalid"
  NICKNAME = "Example"

  def self.enabled?
    !ENV.fetch("BILLIE_DEMO_ENABLED", "true").to_s.strip.downcase.in?(%w[0 false no off])
  end

  def self.user
    User.find_by(email: EMAIL, platform_agent_of_id: nil)
  end

  # Whether the sign-in page should offer the demo.
  def self.available?
    enabled? && user.present?
  end

  def self.email?(email)
    email.to_s.strip.downcase.end_with?("@#{DOMAIN}")
  end
end
