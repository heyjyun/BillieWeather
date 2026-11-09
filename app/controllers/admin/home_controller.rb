module Admin
  # `/supportadmin`: the support-admin overview, separate from the app itself.
  # Admins only (BaseController); everyone else gets a 404.
  class HomeController < BaseController
    def index
      @payment_methods = ::Community::PaymentMethod.all_for_display
      @patron_count = ::Community::Honor.active.patrons.count
      @founding_member_count = ::Community::Honor.active.where(kind: "founding_member").count
      @viewer_count = ::Community::SupportAccess.active.count
    end
  end
end
