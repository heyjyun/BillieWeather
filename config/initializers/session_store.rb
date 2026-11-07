# Be sure to restart your server when you modify this file.

# A project-specific name. Bullet Train's default (_untitled_application_session) is shared by every
# Bullet Train app, and browsers share cookies across localhost ports, so two local apps would
# overwrite each other's session and break the CSRF token.
Rails.application.config.session_store :cookie_store, key: "_billieweather_session"
