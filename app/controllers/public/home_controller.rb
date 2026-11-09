class Public::HomeController < Public::ApplicationController
  layout "billie"
  # The root `/` page is a public, no-login-required description of BillieWeather.
  # See app/views/public/home/index.html.erb.
  def index
  end

  # `/about`: who BillieWeather is for and what it promises. See app/views/public/home/about.html.erb.
  def about
  end

  # `/features`: product features, membership badges, and the voluntary support modal.
  # The modal itself is rendered by the layout on every public page (see
  # CommunityHelper#support_dialog_locals and app/views/community/_support_dialog.html.erb).
  def features
    @supporter_nicknames = Community::Honor.active.patrons.joins(:user)
      .where(users: {supporter_recognition_public: true}).where.not(users: {nickname: nil})
      .order(:granted_at).pluck("users.nickname")
  end

  # Every public page carries the support modal, which can hold a personal payment
  # note and private QR codes for signed-in friends.
  after_action { response.headers["Cache-Control"] = "no-store, private" if user_signed_in? }

  # Allow your application to disable public sign-ups and be invitation only.
  include InviteOnlySupport

  # Make Bullet Train's documentation available at `/docs`.
  include DocumentationSupport
end
