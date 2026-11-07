module Finance
  class Insight < ActiveRecord::Base
    self.table_name = "finance_insights"

    KINDS = %w[general tax].freeze

    belongs_to :user

    validates :source, inclusion: {in: %w[rules openai]}
    validates :kind, inclusion: {in: KINDS}
    validates :generated_at, presence: true
    validate :content_is_an_object

    scope :latest_first, -> { order(generated_at: :desc, id: :desc) }
    scope :general, -> { where(kind: "general") }
    scope :tax, -> { where(kind: "tax") }

    private

    def content_is_an_object
      errors.add(:content, "must be an object") unless content.is_a?(Hash)
    end
  end
end
