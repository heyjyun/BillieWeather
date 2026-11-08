class Api::V1::UsersController < Api::V1::ApplicationController
  include Api::V1::Users::ControllerBase

  private

  def permitted_fields
    [
      :usage_region,
      # 🚅 super scaffolding will insert new fields above this line.
    ]
  end

  def permitted_arrays
    {
      # 🚅 super scaffolding will insert new arrays above this line.
    }
  end

  def process_params(strong_params)
    strong_params
  end
end
