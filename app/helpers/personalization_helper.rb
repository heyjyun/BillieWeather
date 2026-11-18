# View helpers for personalized messages; see app/models/personalization.rb.
module PersonalizationHelper
  # The localized message for `key`, greeting `user` by nickname when they have one.
  def personal_message(key, user = current_user, **vars)
    Personalization.message(key, name: user&.preferred_name, **vars)
  end

  # "Good morning, Jyun!" in the person's language and time zone.
  def personal_greeting(user = current_user, time: personal_time(user))
    Personalization.greeting(name: user&.preferred_name, time: time)
  end

  def personal_time(user = current_user)
    Time.current.in_time_zone(user&.time_zone.presence || "America/Chicago")
  end

  # The gentle nickname suggestion for accounts created before nicknames were required.
  # Dismissing it hides it for the rest of the browser session.
  def show_nickname_prompt?(user = current_user)
    user.present? && user.needs_nickname? && !session[:nickname_prompt_dismissed]
  end
end
