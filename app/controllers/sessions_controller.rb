class SessionsController < Devise::SessionsController
  include Sessions::ControllerBase
  layout "billie"
  before_action :verify_authenticity_token, only: :create
end
