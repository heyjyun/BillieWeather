module CommunitySupportHelpers
  # A real 1×1 PNG, so type detection sees genuine PNG bytes.
  PNG_BYTES = Base64.decode64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

  def with_env(values)
    previous = values.keys.to_h { |key| [key, ENV[key]] }
    values.each { |key, value| ENV[key] = value }
    yield
  ensure
    previous.each { |key, value| ENV[key] = value }
  end

  def with_support_payments(&block)
    with_env("SUPPORT_PAYMENTS_ENABLED" => "true", &block)
  end

  def upload_file(bytes, filename:, content_type:)
    file = Tempfile.new([File.basename(filename, ".*"), File.extname(filename)])
    file.binmode
    file.write(bytes)
    file.rewind
    Rack::Test::UploadedFile.new(file.path, content_type, true, original_filename: filename)
  end

  def store_qr(key, note_supported: true, enabled: true, bytes: PNG_BYTES)
    method = Community::PaymentMethod.for(key)
    method.qr_upload = StringIO.new(bytes)
    method.note_supported = note_supported
    method.enabled = enabled
    method.save!
    method
  end

  def invite(user, by: nil)
    Community::SupportAccess.grant!(user: user, by: by)
  end
end
