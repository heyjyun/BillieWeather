require "base64"
require "json"
require "net/http"
require "timeout"

# Action Mailer delivery method for Render's HTTPS-only transactional email path.
class BilliePostmarkDelivery
  class Error < StandardError; end

  ENDPOINT = URI("https://api.postmarkapp.com/email")
  attr_accessor :settings

  def initialize(settings = {})
    @settings = settings.transform_keys(&:to_sym)
  end

  def deliver!(mail)
    token = settings[:api_token].to_s.strip
    sender = settings[:from].to_s.strip
    raise Error, "Transactional email is not configured. Set POSTMARK_API_TOKEN and a verified MAIL_FROM sender." if token.empty? || sender.empty?

    request = Net::HTTP::Post.new(ENDPOINT)
    request["Accept"] = "application/json"
    request["Content-Type"] = "application/json"
    request["X-Postmark-Server-Token"] = token
    request.body = JSON.generate(payload_for(mail, sender))

    http = Net::HTTP.new(ENDPOINT.host, ENDPOINT.port)
    http.use_ssl = true
    http.open_timeout = 5
    http.read_timeout = 10
    http.write_timeout = 5
    http.max_retries = 0
    response = Timeout.timeout(15) { http.request(request) }
    unless response.is_a?(Net::HTTPSuccess)
      raise Error, "The email service could not deliver this message. Please try again later."
    end
    body = response.body.to_s
    raise Error, "The email service returned an invalid delivery result." if body.bytesize > 20_000
    result = JSON.parse(body)
    unless result.is_a?(Hash) && result["ErrorCode"] == 0 && result["MessageID"].is_a?(String) && !result["MessageID"].empty?
      raise Error, "The email service could not confirm delivery. Please try again later."
    end
    mail
  rescue JSON::ParserError
    raise Error, "The email service returned an invalid delivery result."
  rescue Timeout::Error, SocketError, IOError, SystemCallError, OpenSSL::SSL::SSLError, Net::HTTPError
    raise Error, "The email service is temporarily unavailable. Please try again later."
  end

  private

  def payload_for(mail, sender)
    recipient = formatted_addresses(mail, :to)
    raise Error, "The email message is missing a recipient." if recipient.empty?

    payload = {
      "From" => sender,
      "To" => recipient,
      "Subject" => mail.subject.to_s,
      "MessageStream" => "outbound",
      "TrackOpens" => false,
      "TrackLinks" => "None"
    }
    {cc: "Cc", bcc: "Bcc", reply_to: "ReplyTo"}.each do |header, key|
      value = formatted_addresses(mail, header)
      payload[key] = value unless value.empty?
    end

    if mail.multipart?
      payload["HtmlBody"] = mail.html_part.body.decoded if mail.html_part
      payload["TextBody"] = mail.text_part.body.decoded if mail.text_part
    elsif mail.mime_type == "text/html"
      payload["HtmlBody"] = mail.body.decoded
    else
      payload["TextBody"] = mail.body.decoded
    end
    unless payload["HtmlBody"].to_s.length.positive? || payload["TextBody"].to_s.length.positive?
      raise Error, "The email message is missing its text or HTML content."
    end

    if mail.attachments.any?
      payload["Attachments"] = mail.attachments.map do |attachment|
        value = {
          "Name" => attachment.filename,
          "Content" => Base64.strict_encode64(attachment.body.decoded),
          "ContentType" => attachment.mime_type
        }
        value["ContentID"] = "cid:#{attachment.content_id.to_s.delete_prefix("<").delete_suffix(">")}" if attachment.inline? && attachment.content_id
        value
      end
    end
    payload
  end

  def formatted_addresses(mail, header)
    field = mail[header]
    field ? field.formatted.join(", ") : ""
  end
end
