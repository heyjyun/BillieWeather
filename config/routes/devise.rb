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

# Quick login buttons on the sign-in page (see DemoAccount and PersonalAccount).
scope :users, as: :users do
  post "demo", to: "demo_sessions#create", as: :demo_session
  post "quick_login/personal", to: "personal_sessions#create", as: :personal_session
end
