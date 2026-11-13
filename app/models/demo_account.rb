# The public Example Account: one shared, read-only login backed only by synthetic data.
#
# The account is example@example.com (example.com is reserved by RFC 2606, so no real person
# or Google account owns that mailbox). Nobody can register or switch to that address (see
# User#reserved_demo_email), and it has no usable password: the only way in is
# "Quick Login — Example" (DemoSessionsController), which signs it in on the server.
#
# It does not exist until an operator runs `bin/rails billie:demo:seed`; until then the
# button is hidden. Set BILLIE_DEMO_ENABLED=false to hide it again without deleting anything.
module DemoAccount
  EMAIL = "example@example.com"
  NICKNAME = "Example"

  def self.enabled?
    !ENV.fetch("BILLIE_DEMO_ENABLED", "true").to_s.strip.downcase.in?(%w[0 false no off])
  end

  # The demo user, but only while it holds nothing except data the seeder generated. A user
  # with real records at this address is never treated as the public demo.
  def self.user
    user = User.find_by(email: EMAIL, platform_agent_of_id: nil)
    user if user && Seeder.synthetic_only?(user)
  end

  # Whether the sign-in page should offer the demo.
  def self.available?
    enabled? && user.present?
  end

  def self.email?(email)
    email.to_s.strip.downcase == EMAIL
  end
end
