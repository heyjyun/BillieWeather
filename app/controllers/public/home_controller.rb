class Public::HomeController < Public::ApplicationController
  layout "billie"
  # The root `/` page is a public, no-login-required description of BillieWeather.
  # See app/views/public/home/index.html.erb.
  def index
  end

  # `/about`: who BillieWeather is for and what it promises. See app/views/public/home/about.html.erb.
  def about
  end

  # Allow your application to disable public sign-ups and be invitation only.
  include InviteOnlySupport

  # Make Bullet Train's documentation available at `/docs`.
  include DocumentationSupport
end
