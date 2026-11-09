# Files on the private database service (payment QR codes) must only be served by
# controllers that check authorization. Active Storage's built-in blob and
# representation routes accept any valid signed id, so refuse those blobs there.
module PrivateActiveStorageGuard
  PRIVATE_SERVICES = %w[private_database].freeze

  extend ActiveSupport::Concern

  included do
    before_action :refuse_private_blob
  end

  private

  def refuse_private_blob
    head :not_found if @blob && PRIVATE_SERVICES.include?(@blob.service_name.to_s)
  end
end

Rails.application.config.to_prepare do
  [
    ActiveStorage::Blobs::RedirectController,
    ActiveStorage::Blobs::ProxyController,
    ActiveStorage::Representations::RedirectController,
    ActiveStorage::Representations::ProxyController
  ].each do |controller|
    controller.include(PrivateActiveStorageGuard) unless controller < PrivateActiveStorageGuard
  end
end
