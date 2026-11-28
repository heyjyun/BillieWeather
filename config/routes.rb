Rails.application.routes.draw do
  get "/", to: "public/home#index", as: :billie_home
  get "/about", to: "public/home#about", as: :billie_about
  get "/features", to: "public/home#features", as: :billie_features
  get "/download", to: "public/home#download", as: :billie_download
  # Payment QR images are only served here, after an authorization check.
  get "/support/payment-methods/:key/qr", to: "community/payment_qr_codes#show", as: :community_payment_qr,
    constraints: {key: /alipay|wechat_pay|zelle|venmo/}

  # Support admin: a separate area, not part of the app. Not linked from public pages or
  # the app sidebar; type /supportadmin. Admins with an explicit operator grant only, after signing in;
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
  get "/__billie/dev-status", to: "dev_runtime#show" if Rails.env.development?
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
    resources :transactions, only: [:index, :edit, :update] do
      post :batch, on: :collection
    end
    # Multi-source capture and reconciliation (docs/architecture/receipt-capture-and-reconciliation.md).
    resources :receipts, only: [:index, :create, :show, :update] do
      member do
        get :file
        post :record
        post :link
        patch :dismiss
        patch :reopen
        patch :not_duplicate
        patch :mark_duplicate
      end
    end
    patch "receipts/matches/:match_id/:decision", to: "receipts#decide", as: :receipt_match_decision, constraints: {decision: /confirm|reject|undo|reconsider/}
    resources :capture_tokens, only: [:create, :destroy]
    get "reconciliation", to: "reconciliation#show", as: :reconciliation
    # Default Mode / Manual Mode (progressive disclosure; see Finance::ManualWorkspace).
    patch "mode", to: "modes#update", as: :mode
    get "manual", to: "manual#show", as: :manual
    patch "manual/book", to: "manual#update_book", as: :manual_book
    # Manual bookkeeping (docs/architecture/finance-domain-spec.md): accounts, entries of every kind,
    # trash, operation log, review lists, dimensions, budgets, recurring entries and reports.
    resources :accounts, only: [:index, :new, :create, :edit, :update, :destroy] do
      member do
        patch :archive
        patch :unarchive
        patch :move
        post :adjust
      end
    end
    resources :entries, only: [:new, :create, :edit, :update, :destroy] do
      post :preview_quick, on: :collection
      member do
        patch :restore
        delete :purge
      end
    end
    get "trash", to: "entries#trash", as: :trash
    get "activity", to: "audit_events#index", as: :activity
    post "activity/:batch_id/undo", to: "audit_events#undo", as: :undo_activity
    get "review/income", to: "reviews#income", as: :review_income
    patch "review/income/:id", to: "reviews#reclassify", as: :reclassify_income
    get "review/duplicates", to: "reviews#duplicates", as: :review_duplicates
    patch "review/duplicates/:id", to: "reviews#resolve_duplicate", as: :resolve_duplicate
    scope "lists/:list", constraints: {list: /merchants|projects|tags/}, as: :dimension do
      get "/", to: "dimensions#index", as: :index
      post "/", to: "dimensions#create", as: :create
      patch ":id", to: "dimensions#update", as: :update
      delete ":id", to: "dimensions#destroy", as: :destroy
      post ":id/merge", to: "dimensions#merge", as: :merge
    end
    resources :budgets, only: [:index, :create, :update, :destroy]
    resources :recurring_rules, path: "recurring", only: [:index, :new, :create, :edit, :update, :destroy] do
      post :post_due, on: :collection
      patch :toggle, on: :member
    end
    resource :ledger_report, only: :show, path: "reports", controller: :ledger_reports
    resources :categories, only: [:index, :create, :update, :destroy] do
      post :ai_categorize, on: :collection
      patch :arrange, on: :collection
      post :add_suggested, on: :collection
      member do
        patch :move
        patch :reorder
        patch :expand
        post :merge
      end
    end
    resources :category_proposals, only: [] do
      member do
        post :approve
        post :dismiss
      end
    end
    resources :bank_accounts, only: :update
    resource :forecast, only: :show, controller: :forecast
    resource :report, only: :show, controller: :reports do
      get :download
    end
    resource :financial_data, only: :destroy, controller: :financial_data
    resource :profile, only: :update
    # Feature Library (Settings › Feature Library): which modules the sidebar shows. View preferences only.
    get "settings/features", to: "feature_library#show", as: :feature_library
    post "settings/features/reset", to: "feature_library#reset", as: :reset_feature_library
    patch "settings/sidebar", to: "feature_library#reorder", as: :sidebar_order
    patch "settings/features/:id", to: "feature_library#update", as: :feature_library_module, constraints: {id: /[a-z_]{2,40}/}
    # Transactions › Add & Sync: every way to bring transactions in (links to the existing tools).
    get "add", to: "add_sync#show", as: :add_sync
    get "data", to: "settings#data", as: :data_management
    resource :settings, only: [:show, :update], controller: :settings do
      patch :nickname
      post :dismiss_nickname_prompt
      patch :database_name
      patch :password
      delete :sessions
      delete "rules/:rule_id", action: :remove_rule, as: :remove_rule
      patch :supporter_recognition
      post :password_reset
    end
    # Website-only labels and review decisions for local database METADATA. Nothing here
    # reaches a device or touches financial data.
    resources :local_devices, only: :update, param: :device_id, controller: :local_devices
    patch "local_database_reports/:id/review", to: "local_devices#review", as: :review_local_database_report
    delete "local_database_reports", to: "local_devices#remove", as: :remove_local_database_reports
    resource :insights, only: :show, controller: :insights do
      post :generate
      post :chat, defaults: {format: :json}
    end
    resource :tax_preparation, only: :show, path: "tax", controller: :tax_preparation do
      post :generate
    end
    # The command bar's trusted side (JSON only). The browser parses; these re-check and run.
    scope "command", controller: :commands, as: :command, defaults: {format: :json} do
      get :context
      post :preview
      post :execute
      post :undo
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

  # API for the desktop and mobile apps (clients/universal): sign-in, account preferences,
  # the person's web financial data (download, statement upload for the Data page's database
  # transfers, delete one statement or the whole cloud database after a typed confirmation).
  scope "api/client/v1", module: "client_api/v1", as: "client_api_v1", defaults: {format: :json} do
    resource :session, only: [:create, :destroy]
    post "session/revocations", to: "sessions#revoke_by_digest", as: :session_revocations
    delete "sessions", to: "sessions#destroy_others", as: :other_sessions
    resource :account, only: [:show, :update]
    resource :module_preferences, only: [:show, :update], controller: :module_preferences
    # Read-only copy of the person's web financial data for the app's local database.
    # One-way metadata from the app about its local databases (names, sizes, counts; never financial
    # content). The website only displays it. There is deliberately no route that commands a device.
    put "devices/:device_id/databases/:database_id", to: "local_databases#upsert", as: :local_database
    delete "devices/:device_id/databases/:database_id", to: "local_databases#destroy"
    delete "devices/:device_id", to: "local_databases#purge", as: :local_device
    get "finance", to: "finance#show", as: :finance
    patch "finance", to: "finance#rename", as: :finance_rename
    delete "finance", to: "finance#destroy_all", as: :finance_destroy_all
    post "finance/statements", to: "finance#create_statement", as: :finance_statement_import
    get "finance/statements", to: "finance#statements", as: :finance_statements
    delete "finance/statements/:id", to: "finance#destroy_statement", as: :finance_statement
    get "finance/transactions", to: "finance#transactions", as: :finance_transactions
    get "finance/rules", to: "finance#rules", as: :finance_rules
    get "finance/categories", to: "finance#categories", as: :finance_categories
    post "finance/categorize", to: "finance#categorize", as: :finance_categorize
    # Receipt capture from the apps (bearer session) and iOS Shortcuts / Siri (receipt-only capture token).
    post "finance/receipts", to: "receipts#create", as: :finance_receipts
    get "finance/receipts/:id", to: "receipts#show", as: :finance_receipt
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
