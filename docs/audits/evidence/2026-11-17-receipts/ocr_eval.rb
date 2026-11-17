# OCR evaluation: synthetic receipt images → Apple Vision (billie-vision-cli, on this Mac) →
# Finance::LocalOcr rows → Finance::ReceiptParser, compared with the fixture's expected values.
#   BILLIE_LOCAL_OCR_COMMAND=<cli> bin/rails runner docs/audits/evidence/2026-11-17-receipts/ocr_eval.rb <manifest.json>
# Prints per-field accuracy per variant, and how often a WRONG value was reported as trusted
# (confidence >= 0.8) — the number that matters for "never present a guess as fact".
manifest = JSON.parse(File.read(ARGV.fetch(0)))
FIELDS = {"merchant" => "merchant", "date" => "date", "total" => "total", "currency" => "currency"}
stats = Hash.new { |h, k| h[k] = Hash.new(0) }
rows = []
manifest.each do |item|
  bytes = File.binread(item["path"])
  ocr = Finance::LocalOcr.recognize(bytes, "image/png")
  options = item["options"]
  parsed = ocr && Finance::ReceiptParser.parse(ocr[:lines], default_currency: options["defaultCurrency"], today: options["today"] || "2026-11-16", date_order: options["dateOrder"])
  variant = item["variant"]
  stats[variant]["images"] += 1
  confident = parsed && Finance::ReceiptParser.confident?(parsed)
  stats[variant]["confident"] += 1 if confident
  FIELDS.each do |key, field|
    expected = item["expect"][key]
    next if expected.nil? && !item["expect"].key?(key)
    value = parsed&.dig("fields", field, "value")
    conf = parsed&.dig("fields", field, "confidence").to_f
    ok = value.to_s.unicode_normalize(:nfkc).casecmp?(expected.to_s.unicode_normalize(:nfkc))
    stats[variant]["#{key}_n"] += 1
    stats[variant]["#{key}_ok"] += 1 if ok
    stats[variant]["#{key}_wrong_trusted"] += 1 if !ok && !value.nil? && conf >= Finance::ReceiptParser::CONFIDENT
    rows << [item["case"], variant, key, expected, value, conf] unless ok
  end
  stats[variant]["confident_but_wrong"] += 1 if confident && FIELDS.keys.first(3).any? { |key| item["expect"].key?(key) && parsed.dig("fields", FIELDS[key], "value").to_s.unicode_normalize(:nfkc).casecmp?(item["expect"][key].to_s.unicode_normalize(:nfkc)) == false }
end
engine = Finance::LocalOcr.recognize(File.binread(manifest.first["path"]), "image/png")&.dig(:engine)
puts "engine: #{engine}"
puts "variant        images  merchant  date    total   currency  auto-trusted  trusted-but-wrong  wrong-value-shown-as-trusted"
stats.each do |variant, s|
  pct = ->(key) { s["#{key}_n"].zero? ? "  -   " : format("%3d/%-3d", s["#{key}_ok"], s["#{key}_n"]) }
  wrong = FIELDS.keys.sum { |key| s["#{key}_wrong_trusted"] }
  puts format("%-14s %6d  %-8s  %-6s  %-6s  %-8s  %12d  %17d  %28d", variant, s["images"], pct.call("merchant"), pct.call("date"), pct.call("total"), pct.call("currency"), s["confident"], s["confident_but_wrong"], wrong)
end
puts "\nmisreads (case, variant, field, expected, got, confidence):"
rows.each { |row| puts row.inspect }
