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

# Permit CORS from any origin for API routes
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  # The BillieWeather apps (Tauri WebViews on macOS/iOS, Windows/Android, and the dev server).
  # Bearer tokens only; no cookies are sent cross-origin.
  allow do
    origins "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"
    resource "/api/client/v1/*", headers: ["Authorization", "Content-Type", "Accept"], methods: [:get, :post, :patch, :delete, :options], max_age: 600
  end

  allow do
    origins "*"
    resource "/api/*", headers: :any
  end
end
