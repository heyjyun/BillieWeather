module Community
  # One of the four payment services, its admin-uploaded QR code, and whether it is
  # shown in the support modal. The QR image is an Active Storage attachment on the
  # private database service: it has no public URL and is only served by
  # Community::PaymentQrCodesController after an authorization check.
  class PaymentMethod < ActiveRecord::Base
    self.table_name = "community_payment_methods"

    # SVG is excluded on purpose: it can carry script.
    ALLOWED_CONTENT_TYPES = %w[image/png image/jpeg image/webp].freeze
    EXTENSIONS = {"image/png" => "png", "image/jpeg" => "jpg", "image/webp" => "webp"}.freeze
    MAX_BYTES = 2.megabytes

    belongs_to :updated_by, class_name: "User", optional: true
    # :purge (not :purge_later): production runs no background worker, and a replaced
    # or removed QR code should be gone right away.
    has_one_attached :qr_code, service: :private_database, dependent: :purge

    scope :enabled, -> { where(enabled: true) }

    validates :key, inclusion: {in: Community::PAYMENT_METHODS}, uniqueness: true
    validate :valid_qr_upload
    validate :qr_required_to_enable

    # All four services in display order, including ones without an uploaded code yet.
    def self.all_for_display
      existing = where(key: Community::PAYMENT_METHODS).includes(qr_code_attachment: :blob).index_by(&:key)
      Community::PAYMENT_METHODS.map { |key| existing[key] || new(key: key) }
    end

    # What the support modal shows: enabled services with an uploaded code, in display order.
    def self.available_for_display
      all_for_display.select(&:available?)
    end

    def self.for(key)
      raise ActiveRecord::RecordNotFound unless Community::PAYMENT_METHODS.include?(key.to_s)
      find_or_initialize_by(key: key.to_s)
    end

    def label
      Community.payment_method_label(key)
    end

    def qr_present?
      qr_code.attached?
    end

    def available?
      enabled? && qr_present?
    end

    def qr_content_type
      qr_code.blob&.content_type
    end

    def qr_byte_size
      qr_code.blob&.byte_size
    end

    def qr_extension
      EXTENSIONS.fetch(qr_content_type, "bin")
    end

    def qr_filename
      "billieweather-#{key.dasherize}-qr.#{qr_extension}"
    end

    # Changes whenever the image is replaced, so browsers never show a stale code.
    def qr_version
      qr_code.blob&.checksum.to_s.delete("^A-Za-z0-9").first(12)
    end

    # Accepts an uploaded file. The type is detected from the bytes, not the filename
    # or the browser's claim, so a renamed file cannot slip through. Nothing is stored
    # unless the upload is valid.
    def qr_upload=(upload)
      @qr_upload_error = nil
      return if upload.blank?
      return @qr_upload_error = :invalid unless upload.respond_to?(:read)
      return @qr_upload_error = :too_large if upload.respond_to?(:size) && upload.size > MAX_BYTES

      data = upload.read(MAX_BYTES + 1).to_s.b
      upload.rewind if upload.respond_to?(:rewind)
      return @qr_upload_error = :too_large if data.bytesize > MAX_BYTES

      content_type = Marcel::MimeType.for(StringIO.new(data))
      return @qr_upload_error = :wrong_type unless ALLOWED_CONTENT_TYPES.include?(content_type)

      # identify: false keeps the content type detected above; analyzed: true skips the
      # background analysis job (no worker in production, and nothing to learn from it).
      self.qr_code = {io: StringIO.new(data), filename: "#{key}-qr.#{EXTENSIONS.fetch(content_type)}",
                      content_type: content_type, identify: false, metadata: {"analyzed" => true, "identified" => true}}
    end

    # Deletes the image and hides the method from the modal.
    def remove_qr!(by: nil)
      transaction do
        update!(enabled: false, updated_by: by || updated_by)
        qr_code.purge if qr_present?
      end
    end

    private

    def valid_qr_upload
      case @qr_upload_error
      when :too_large then errors.add(:base, I18n.t("billie.community.admin.qr_too_large", size: "2 MB"))
      when :invalid, :wrong_type then errors.add(:base, I18n.t("billie.community.admin.qr_wrong_type"))
      end
    end

    def qr_required_to_enable
      errors.add(:base, I18n.t("billie.community.admin.qr_required_to_enable")) if enabled? && !qr_present? && @qr_upload_error.nil?
    end
  end
end
