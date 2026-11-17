require "open3"

module Finance
  # Optional on-server OCR for receipt images uploaded on the website, through a LOCAL command only.
  # Unset by default: the website then asks the person to type the details (or to scan with the app or
  # an iOS Shortcut, which recognize text on the phone). Nothing is ever sent to a third-party service.
  #
  #   BILLIE_LOCAL_OCR_COMMAND=/path/to/billie-vision-cli   (clients/universal/src-tauri/ocr-apple/cli, macOS)
  #
  # The command is called as `<command> <languages> <image file>` and must print one OcrResult JSON
  # object (packages/finance-core/src/universal/ocr.ts) per image. Lines are returned in reading order.
  module LocalOcr
    TIMEOUT = 20
    LANGUAGES = "en-US,zh-Hans,zh-Hant,ja-JP,ko-KR,es-ES,fr-FR,de-DE"
    IMAGE_TYPES = %w[image/jpeg image/png image/heic image/heif image/webp].freeze

    module_function

    def command = ENV["BILLIE_LOCAL_OCR_COMMAND"].presence

    def available? = command.present? && File.executable?(command)

    # Returns {engine:, lines: [{text:, confidence:}]} or nil.
    def recognize(bytes, content_type)
      return nil unless available? && IMAGE_TYPES.include?(content_type)
      Tempfile.create(["receipt", ".#{content_type.split("/").last}"], binmode: true) do |file|
        file.write(bytes)
        file.flush
        output, status = run(command, ENV["BILLIE_LOCAL_OCR_LANGUAGES"].presence || LANGUAGES, file.path)
        return nil unless status&.success?
        parse_output(output)
      end
    rescue SystemCallError, JSON::ParserError
      nil
    end

    def parse_output(output)
      result = JSON.parse(output.lines.first.to_s)
      lines = Array(result["pages"]).flat_map { |page| rows(Array(page["lines"])) }
      return nil if lines.empty?
      engine = result["engine"].is_a?(Hash) ? [result.dig("engine", "id"), result.dig("engine", "version")].compact.join(" ") : "local-ocr"
      {engine: engine.first(60), lines: lines}
    end

    # Engines return a label and its amount ("TOTAL", "48.60") as separate observations on one printed
    # row. The parser reads one row per line, so observations whose vertical centers are within half a
    # line height are joined left to right; the row keeps the lowest confidence of its parts.
    def rows(observations)
      observations = observations.select { |line| line["text"].to_s.strip.present? }
      return [] if observations.empty?
      heights = observations.map { |line| line["height"].to_f }.select(&:positive?).sort
      tolerance = (heights.empty? ? 10.0 : heights[heights.length / 2]) / 2.0
      grouped = []
      observations.sort_by { |line| line["y"].to_f + line["height"].to_f / 2 }.each do |line|
        center = line["y"].to_f + line["height"].to_f / 2
        row = grouped.last
        if row && (center - row[:center]).abs <= tolerance
          row[:items] << line
        else
          grouped << {center: center, items: [line]}
        end
      end
      grouped.map do |row|
        items = row[:items].sort_by { |line| line["x"].to_f }
        confidences = items.filter_map { |line| line["confidence"]&.to_f }
        {text: items.map { |line| line["text"].to_s.strip }.join("  "), confidence: confidences.min}
      end
    end

    def run(*argv)
      Open3.popen2(*argv) do |stdin, stdout, thread|
        stdin.close
        unless thread.join(TIMEOUT)
          Process.kill("KILL", thread.pid)
          return [nil, nil]
        end
        [stdout.read, thread.value]
      end
    end
  end
end
