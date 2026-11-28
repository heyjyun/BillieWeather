module Finance
  # Check user-controlled provider inputs separately from API authorization headers.
  module ProviderPrivacy
    NUMBER = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/
    CREDENTIAL = %r{
      -----BEGIN\s[A-Z\s]*PRIVATE\sKEY----- |
      \bsecret\s*(?:is\b|[=:：])\s*\S+ |
      \bBearer\s+[\w.\-]+ |
      \b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,}|AKIA[A-Z0-9]{16})\b |
      \beyJ[\w-]+\.[\w-]+\.[\w-]+\b |
      \b[\w.+-]+://[^\s/]+:[^\s/]+@ |
      (?:password|passcode|api[_\s-]?key|access[_\s-]?token|client[_\s-]?secret|cvv|cvc|one.time.code|密码|密碼|パスワード|비밀번호|contraseña)
        \s*(?:is\b|es\b|[=:：]|为|為|\s)\s*\S+
    }ix

    def self.sensitive?(text)
      NUMBER.match?(text) || CREDENTIAL.match?(text)
    end
  end
end
