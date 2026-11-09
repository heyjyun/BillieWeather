Rails.application.routes.draw do
  get "/", to: "public/home#index", as: :billie_home
  get "/about", to: "public/home#about", as: :billie_about
  get "/features", to: "public/home#features", as: :billie_features
  # Payment QR images are only served here, after an authorization check.
  get "/support/payment-methods/:key/qr", to: "community/payment_qr_codes#show", as: :community_payment_qr,
    constraints: {key: /alipay|wechat_pay|zelle|venmo/}

  # Support admin: a separate area, not part of the app. Not linked from public pages or
  # the app sidebar; type /supportadmin. Admins (DEVELOPER_EMAILS) only, after signing in;
  # everyone else gets a 404. /admin itself is left free for other tools.
  scope "supportadmin", module: :admin, as: :admin do
    get "/", to: "home#index", as: :root
    # Membership: people, honor badges, and who may see the payment QR codes.
    get "community", to: "community#index", as: :community
    scope "community", as: "community" do
      resources :users, only: :show, controller: "community_users" do
        resources :honors, only: :create, controller: "community_honors" do
          patch :revoke, on: :member
        end
        resource :support_access, only: [:create, :destroy], controller: "community_support_accesses"
      end
    end
    # Payment methods: QR uploads and which methods appear in the support modal.
    resources :payment_methods, only: [:index, :update], param: :key, path: "payment-methods",
      constraints: {key: /alipay|wechat_pay|zelle|venmo/} do
      delete :qr, on: :member, action: :remove_qr
    end
  end
  get "/up", to: "rails/health#show", as: :billie_health
  get "/users/google/region", to: "google_regions#new", as: :new_google_region
  post "/users/google/region", to: "google_regions#create", as: :google_region

  namespace :finance, path: "app" do
    get "/", to: "dashboard#index", as: :dashboard
    resources :statements, only: [:index, :create, :update, :destroy] do
      get :sample, on: :collection
    end
    resources :statement_drafts, only: [:show, :destroy] do
      post :confirm, on: :member
    end
    resources :transactions, only: [:index, :edit, :update]
    resources :bank_accounts, only: :update
    resource :forecast, only: :show, controller: :forecast
    resource :report, only: :show, controller: :reports do
      get :download
    end
    resource :financial_data, only: :destroy, controller: :financial_data
    resource :profile, only: :update
    resource :settings, only: [:show, :update], controller: :settings do
      patch :nickname
      patch :password
      patch :supporter_recognition
      post :password_reset
    end
    resource :insights, only: :show, controller: :insights do
      post :generate
    end
    resource :tax_preparation, only: :show, path: "tax", controller: :tax_preparation do
      post :generate
    end
  end

  # See `config/routes/*.rb` to customize these configurations.
  draw "concerns"
  draw "devise"
  draw "sidekiq"
  draw "avo"

  # `collection_actions` is automatically super scaffolded to your routes file when creating certain objects.
  # This is helpful to have around when working with shallow routes and complicated model namespacing. We don't use this
  # by default, but sometimes Super Scaffolding will generate routes that use this for `only` and `except` options.
  collection_actions = [:index, :new, :create] # standard:disable Lint/UselessAssignment

  # This helps mark `resources` definitions below as not actually defining the routes for a given resource, but just
  # making it possible for developers to extend definitions that are already defined by the `bullet_train` Ruby gem.
  # TODO Would love to get this out of the application routes file.
  extending = {only: []}

  scope module: "public" do
    # To keep things organized, we put non-authenticated controllers in the `Public::` namespace.
    # The root `/` path is routed to `Public::HomeController#index` by default. You can set it
    # to whatever you want by doing something like this:
    # root to: "my_new_root_controller#index"
  end

  namespace :webhooks do
    namespace :incoming do
      namespace :oauth do
        # 🚅 super scaffolding will insert new oauth provider webhooks above this line.
      end
    end
  end

  namespace :api do
    draw "api/v1"
    # 🚅 super scaffolding will insert new api versions above this line.
  end

  namespace :account do
    shallow do
      # The account root `/` path is routed to `Account::Dashboard#index` by default. You can set it
      # to whatever you want by doing something like this:
      # root to: "some_other_root_controller#index", as: "dashboard"

      # user-level onboarding tasks.
      namespace :onboarding do
        # routes for standard onboarding steps are configured in the `bullet_train` gem, but you can add more here.
      end

      # user specific resources.
      resources :users, extending do
        namespace :oauth do
          # 🚅 super scaffolding will insert new oauth providers above this line.
        end

        # routes for standard user actions and resources are configured in the `bullet_train` gem, but you can add more here.
      end

      # team-level resources.
      resources :teams, extending do
        # routes for many teams actions and resources are configured in the `bullet_train` gem, but you can add more here.

        # add your resources here.

        resources :invitations, extending do
          # routes for standard invitation actions and resources are configured in the `bullet_train` gem, but you can add more here.
        end

        resources :memberships, extending do
          # routes for standard membership actions and resources are configured in the `bullet_train` gem, but you can add more here.
        end

        namespace :integrations do
          # 🚅 super scaffolding will insert new integration installations above this line.
        end
      end
    end
  end
end
