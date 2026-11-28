module Finance
  class AccountCapturesController < BaseController
    rate_limit to: 40, within: 1.minute, by: -> { current_user.id }

    def create
      return head :payload_too_large if request.content_length.to_i > 32.kilobytes
      body = request.request_parameters
      ids = AccountCapture.new(current_user, @profile.currency).call(key: body["key"], rows: body["rows"], source: body["source"], confirmed: body["confirmed"])
      session[:last_account_capture] = body["key"]
      render json: {ids: ids}
    rescue AccountCapture::Duplicate, ActiveRecord::RecordNotUnique
      render json: {error: "duplicate"}, status: :conflict
    rescue AccountCapture::Invalid, ActiveRecord::RecordInvalid
      render json: {error: "invalid"}, status: :unprocessable_entity
    end

    def undo
      AccountCapture.new(current_user,@profile.currency).undo(params[:key])
      session.delete(:last_account_capture)
      redirect_to finance_accounts_path
    rescue AccountCapture::Invalid, ActiveRecord::InvalidForeignKey
      redirect_to finance_accounts_path, alert: helpers.assistant_copy["undoConflict"]
    end

    def screenshot
      return head :service_unavailable unless LocalOcr.available?
      file = params[:file]
      return head :unprocessable_entity unless file.is_a?(ActionDispatch::Http::UploadedFile) && file.size.between?(1, 8.megabytes)
      mime = Marcel::MimeType.for(file.tempfile)
      file.rewind
      result = LocalOcr.recognize(file.read, mime)
      return head :unprocessable_entity unless result
      render json: {lines: result[:lines].first(200)}
    end
  end
end
