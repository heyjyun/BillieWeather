module Finance
  # Port of packages/finance-core/src/receipt/merchant.ts: whether a receipt's "Whole Foods Market" and a
  # bank's "WHOLEFDS MKT #10234" name the same business. Both read schema/merchant-aliases.json and replay
  # fixtures/receipts/match-cases.json (test/services/finance/receipt_contract_test.rb).
  module MerchantIdentity
    DATA = JSON.parse(File.read(Rails.root.join("packages/finance-core/schema/merchant-aliases.json"))).freeze
    PREFIXES = DATA.fetch("prefixes").sort_by { |prefix| -prefix.length }.freeze
    NOISE = DATA.fetch("noise").to_set.freeze
    GENERIC = DATA.fetch("generic").to_set.freeze
    ALIASES = DATA.fetch("aliases").flat_map { |canonical, phrases| phrases.map { |phrase| [phrase, canonical] } }
      .sort { |a, b| [-a[0].length, a[0]] <=> [-b[0].length, b[0]] }.freeze

    Identity = Data.define(:key, :known)

    module_function

    def letters(text)
      text.unicode_normalize(:nfkd).gsub(/\p{M}/, "").downcase.gsub(/['’`]/, "").gsub(/[^\p{L}]+/, " ").strip.squeeze(" ")
    end

    def strip_prefixes(raw)
      text = raw.unicode_normalize(:nfkc).downcase.strip
      starred = text.match(/\A([a-z]{1,8})[[:space:]]?\*[[:space:]]?(.+)\z/)
      text = starred[2] if starred && PREFIXES.include?(starred[1])
      normalized = letters(text)
      loop do
        prefix = PREFIXES.find { |candidate| candidate.length >= 3 && normalized.start_with?("#{candidate} ") && normalized.length > candidate.length + 2 }
        break unless prefix
        normalized = normalized[(prefix.length + 1)..]
      end
      normalized
    end

    def identity(text)
      return Identity.new(key: nil, known: false) if text.blank?
      normalized = strip_prefixes(text.to_s)
      return Identity.new(key: nil, known: false) if normalized.empty?
      compact_text = normalized.delete(" ")
      first_token = normalized.split(" ").first
      ALIASES.each do |phrase, canonical|
        return Identity.new(key: canonical, known: true) if normalized == phrase || normalized.start_with?("#{phrase} ")
        compact_phrase = phrase.delete(" ")
        if phrase.include?(" ") && compact_text.start_with?(compact_phrase) && first_token.start_with?(compact_phrase)
          return Identity.new(key: canonical, known: true)
        end
      end
      tokens = normalized.split(" ").select { |token| !NOISE.include?(token) && (token.length >= 2 || token.match?(/[^\x00-\x7F]/)) }
      return Identity.new(key: nil, known: false) if tokens.empty?
      tokens.pop while tokens.length > 1 && tokens.last.match?(/\A[a-z]{2}\z/)
      Identity.new(key: tokens.first(3).join(" "), known: false)
    end

    def key(text) = identity(text).key

    def skeleton(compact) = compact.gsub(/[aeiou]/, "").squeeze

    def bigrams(text) = text.chars.each_cons(2).map(&:join)

    def dice(a, b)
      left = bigrams(a)
      right = bigrams(b)
      return ((a == b) ? 1.0 : 0.0) if left.empty? || right.empty?
      counts = left.tally
      overlap = right.count do |gram|
        next false unless counts[gram].to_i.positive?
        counts[gram] -= 1
        true
      end
      (2.0 * overlap) / (left.length + right.length)
    end

    def round2(value) = (value * 100).round / 100.0

    # 0..1, or nil when either name has no identity (unknown is not "different").
    def similarity(a, b)
      left = key(a)
      right = key(b)
      return nil if left.nil? || right.nil?
      return 1.0 if left == right
      compact_left = left.delete(" ")
      compact_right = right.delete(" ")
      return 0.95 if compact_left == compact_right
      shorter, longer = (compact_left.length <= compact_right.length) ? [compact_left, compact_right] : [compact_right, compact_left]
      score = round2(dice(compact_left, compact_right) * 0.9)
      score = [score, 0.85].max if shorter.length >= 5 && longer.start_with?(shorter)
      first_left = left.split(" ").first
      first_right = right.split(" ").first
      score = [score, 0.85].max if first_left == first_right && first_left.length >= 4 && !GENERIC.include?(first_left)
      outline_left = skeleton(compact_left)
      score = [score, 0.8].max if outline_left.length >= 4 && outline_left == skeleton(compact_right)
      round2([score, 0.95].min)
    end
  end
end
