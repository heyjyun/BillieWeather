# The welcome email for a new BillieWeather account, in the language the person signed up in and
# addressed by their nickname. Replaces Bullet Train's placeholder UserMailer#welcome (see
# User#send_welcome_email). Contains no financial information.
class WelcomeMailer < ApplicationMailer
  def welcome(user)
    @user = user
    locale = params&.dig(:locale).to_s
    locale = I18n.default_locale.to_s unless I18n.available_locales.map(&:to_s).include?(locale)
    I18n.with_locale(locale) do
      @heading = Personalization.message("email.heading", name: user.preferred_name)
      @cta_url = finance_dashboard_url
      mail(to: user.email, subject: I18n.t("billie.personalization.email.subject"), template_path: "welcome_mailer", template_name: "welcome")
    end
  end
end
