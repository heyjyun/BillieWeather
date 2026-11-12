devise_for :users, controllers: {
  registrations: "registrations",
  sessions: "sessions",
  passwords: "passwords",
  omniauth_callbacks: "account/oauth/omniauth_callbacks"
}

devise_scope :user do
  scope :users, as: :users do
    post "pre_otp", to: "sessions#pre_otp"
  end
end

# Quick account selection on the sign-in page (see DemoAccount and RememberedAccount).
scope :users, as: :users do
  post "demo", to: "demo_sessions#create", as: :demo_session
  delete "remembered_account", to: "remembered_accounts#destroy", as: :remembered_account
end
