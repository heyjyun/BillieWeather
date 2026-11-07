class RegistrationsController < Devise::RegistrationsController
  include Registrations::ControllerBase
  layout "billie"
end
