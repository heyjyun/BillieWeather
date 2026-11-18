# Personalized, localized messages (config/locales/billie_personalization.*.yml).
#
# A message that can include someone's nickname has a "named" and a "plain" form. The named form is
# used only when the account has a nickname; otherwise the plain one is, so nobody is ever greeted by
# their email address or by a name we guessed. The nickname is inserted by the translation template,
# so each language places it where it reads naturally ("Good morning, Jyun!", "Jyunさん、おはようございます！").
#
# This reads only the nickname and the clock. It never looks at, sends, or stores financial data.
module Personalization
  DAY_PARTS = %i[morning afternoon evening].freeze

  module_function

  # 05:00–11:59 morning, 12:00–17:59 afternoon, otherwise evening (late night included: "Good
  # evening" reads better at 1 a.m. than "Good morning").
  def day_part(time)
    case time.hour
    when 5..11 then :morning
    when 12..17 then :afternoon
    else :evening
    end
  end

  # The localized message for `key` (e.g. :import_done or "forecast.gap"), with the nickname when there is one.
  def message(key, name: nil, **vars)
    name = name.to_s.squish.presence
    form = name ? :named : :plain
    I18n.t("billie.personalization.#{key}.#{form}", **vars, name: name)
  end

  def greeting(name:, time:)
    message("greeting.#{day_part(time)}", name: name)
  end

  # The line under the dashboard greeting: an invitation for an empty book, a gentle note when
  # something is waiting, otherwise a calm line for the time of day. The greeting right above it
  # already says the name, so this line never repeats it.
  def dashboard_subtitle(time:, has_transactions:, needs_attention: false)
    return message("dashboard.first_use") unless has_transactions
    return I18n.t("billie.personalization.dashboard.attention") if needs_attention
    I18n.t("billie.personalization.dashboard.#{day_part(time)}")
  end

  # How the cash-flow forecast reads, without overstating it. :gap when the projected balance goes
  # below zero, :range_dips when only the illustrative lower range does, otherwise :stable.
  # Returns nil when there is no usable starting balance (nothing honest to say yet).
  def forecast_outlook(forecast)
    return unless forecast.is_a?(Hash) && forecast[:balance_available] && forecast[:points].present?
    points = forecast[:points]
    first_gap = points.find { |point| point[:balance].to_d.negative? }
    return {kind: :gap, date: first_gap[:date]} if first_gap
    return {kind: :range_dips} if points.any? { |point| point[:lower] && point[:lower].to_d.negative? }
    {kind: :stable}
  end
end
