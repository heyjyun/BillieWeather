module Finance
  # A spending limit per month or year (预算): the total, one category (with its children) or one project.
  class Budget < ActiveRecord::Base
    self.table_name = "finance_budgets"

    belongs_to :user
    belongs_to :project, class_name: "Finance::Project", optional: true

    validates :period, inclusion: {in: Domain::BUDGET_PERIODS}
    validates :amount, numericality: {greater_than: 0, less_than: 10**13}
    validates :alert_percent, numericality: {only_integer: true, in: 1..100}
    validate :one_scope
    validate :same_owner

    def scope_label
      return project.name if project
      category.presence
    end

    private

    def one_scope
      errors.add(:base, :one_scope) if category.present? && project_id.present?
    end

    def same_owner
      errors.add(:project, :same_owner) if project && project.user_id != user_id
    end
  end
end
