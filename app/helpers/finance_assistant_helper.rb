module FinanceAssistantHelper
  COPY = JSON.parse(Rails.root.join("packages/shared-types/schema/assistant-copy.json").read).freeze

  def assistant_copy
    COPY.fetch(I18n.locale.to_s, COPY.fetch("en"))
  end
end
