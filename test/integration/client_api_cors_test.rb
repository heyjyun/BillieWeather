require "test_helper"

# The apps call the API from a WebView on another origin, so every method they use must pass
# the browser's CORS preflight. (A missing method fails silently in the app.)
class ClientApiCorsTest < ActionDispatch::IntegrationTest
  APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"].freeze
  DEVICE = "3f2b1c9e-7a4d-4e8b-9c11-0a1b2c3d4e5f"
  DATABASE = "11111111-2222-4333-8444-555555555555"

  def preflight(path, method, origin)
    process :options, path, headers: {"Origin" => origin, "Access-Control-Request-Method" => method, "Access-Control-Request-Headers" => "authorization,content-type"}
    response.headers["Access-Control-Allow-Methods"].to_s.split(/,\s*/)
  end

  test "every method the apps use is allowed from every app origin" do
    {
      "/api/client/v1/devices/#{DEVICE}/databases/#{DATABASE}" => %w[PUT DELETE],
      "/api/client/v1/devices/#{DEVICE}" => %w[DELETE],
      "/api/client/v1/finance" => %w[GET PATCH DELETE],
      "/api/client/v1/finance/statements" => %w[GET POST],
      "/api/client/v1/session" => %w[POST DELETE],
      "/api/client/v1/account" => %w[GET PATCH]
    }.each do |path, methods|
      APP_ORIGINS.each do |origin|
        methods.each do |method|
          assert_includes preflight(path, method, origin), method, "#{method} #{path} from #{origin}"
          assert_equal origin, response.headers["Access-Control-Allow-Origin"]
        end
      end
    end
  end

  test "other websites are not allowed" do
    preflight("/api/client/v1/devices/#{DEVICE}/databases/#{DATABASE}", "PUT", "https://evil.example")
    assert_nil response.headers["Access-Control-Allow-Origin"]
  end
end
