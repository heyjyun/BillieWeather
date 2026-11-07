class Account::Oauth::OmniauthCallbacksController < Devise::OmniauthCallbacksController
  include Account::Oauth::OmniauthCallbacks::ControllerBase

  # TODO Allow packages like `bullet_train-integrations-stripe` to register these automatically.
  def stripe_connect
    callback("Stripe", team_id_from_env)
  end

  def google_oauth2
    session.delete(:pending_google_identity)
    service = GoogleSignIn.new(auth: request.env["omniauth.auth"], current_user: current_user,
      allow_signup: show_sign_up_options?, create_team: session[:invitation_uuid].blank?)
    user = service.call
    sign_in(:user, user, event: :authentication)
    handle_outstanding_invitation
    user.create_default_team unless user.teams.exists?
    user.send_welcome_email if service.created
    redirect_to after_sign_in_path_for(user), notice: "Signed in with Google."
  rescue GoogleSignIn::LinkRequired => error
    session[:pending_google_identity] = error.identity
    redirect_to new_user_session_path, notice: error.message
  rescue GoogleSignIn::Error => error
    redirect_to new_user_session_path, alert: error.message
  end

  def failure
    strategy = request.env["omniauth.error.strategy"]
    return super unless strategy&.name.to_s == "google_oauth2" || request.path.include?("/google_oauth2")

    session.delete(:pending_google_identity)
    redirect_to new_user_session_path, alert: "Google sign-in was not completed. Please try again or use email and password."
  end

  # 🚅 super scaffolding will insert new oauth providers above this line.
end
