require "capybara/selenium/driver"
require "capybara/selenium/driver_specializations/chrome_driver"

# Chrome 158 refuses the "*" origin Capybara 3.40 uses to clear a session, so every browser test failed.
# Clears the cookies of the whole browser and the stored data of the tested site instead.
module ChromeSessionReset
  def reset!
    super
  rescue Selenium::WebDriver::Error::InvalidArgumentError => error
    raise unless error.message.include?("* is not a valid URL")
    execute_cdp("Network.clearBrowserCookies")
    execute_cdp("Storage.clearDataForOrigin", origin: Capybara.app_host, storageTypes: "local_storage,session_storage")
  end
end
Capybara::Selenium::Driver::ChromeDriver.prepend(ChromeSessionReset)
