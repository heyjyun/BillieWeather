module Finance
  # Regular expressions that behave like the TypeScript originals in packages/finance-core.
  # JavaScript's \b looks only at ASCII word characters; Ruby's treats any letter (é, カ) as a word
  # character. The receipt parser and merchant identity are contract-tested against the same fixtures
  # on both sides, so \b is rewritten into ASCII lookarounds here.
  module JsRegexp
    WORD = "A-Za-z0-9_"
    BOUNDARY = "(?:(?<=[#{WORD}])(?![#{WORD}])|(?<![#{WORD}])(?=[#{WORD}]))"

    def self.[](regexp)
      Regexp.new(regexp.source.gsub("\\b", BOUNDARY), regexp.options)
    end
  end
end
