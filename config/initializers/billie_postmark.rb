require Rails.root.join("app/services/billie_postmark_delivery")

# Register the :postmark name already selected by production.rb, without a gem.
ActiveSupport.on_load(:action_mailer) do
  add_delivery_method :postmark, BilliePostmarkDelivery,
    api_token: ENV["POSTMARK_API_TOKEN"],
    from: ENV["MAIL_FROM"]
end
