# Be sure to restart your server when you modify this file.

# Avoid CORS issues when API is called from the frontend app.
# Handle Cross-Origin Resource Sharing (CORS) in order to accept cross-origin Ajax requests.

# Read more: https://github.com/cyu/rack-cors

# Rails.application.config.middleware.insert_before 0, Rack::Cors do
#   allow do
#     origins "example.com"
#
#     resource "*",
#       headers: :any,
#       methods: [:get, :post, :put, :patch, :delete, :options, :head]
#   end
# end

# Origins allowed to call the apps' API (/api/client/v1). Bearer tokens only; no cookies cross-origin.
module BillieCors
  # The Tauri WebViews (macOS/iOS, Windows/Android) and the app's dev server. Production uses exactly this list.
  APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"].freeze
  # Development and test only: the dev server on 127.0.0.1, and the isolated diagnostic build's Vite on
  # port 1430 (an isolated diagnostic build with its own identifier, data folder and WebView origin).
  DEV_APP_ORIGINS = ["http://127.0.0.1:1420", "http://localhost:1430", "http://127.0.0.1:1430"].freeze

  def self.app_origins(environment = Rails.env)
    %w[development test].include?(environment.to_s) ? APP_ORIGINS + DEV_APP_ORIGINS : APP_ORIGINS
  end
end

Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins(*BillieCors.app_origins)
    resource "/api/client/v1/*", headers: ["Authorization", "Content-Type", "Accept"], methods: [:get, :post, :put, :patch, :delete, :options], max_age: 600
  end

  # The Bullet Train REST API (/api/v1, OAuth bearer tokens) stays open to any origin, as before.
  # The apps' API (/api/client/...) never is: rack-cors uses the first matching rule, so without this
  # exclusion any website got "Access-Control-Allow-Origin: *" for GET requests with an Authorization header there.
  allow do
    origins "*"
    resource "/api/*", headers: :any, if: ->(env) {
      !env.fetch("PATH_INFO", "").match?(%r{\A/api/client(?:[./]|\z)})
    }
  end
end
