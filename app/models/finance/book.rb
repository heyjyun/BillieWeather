module Finance
  # A financial book (账本): the future tenant boundary. Each user gets one default book lazily;
  # existing tables are still scoped by user_id (spec §1).
  class Book < ActiveRecord::Base
    self.table_name = "finance_books"

    belongs_to :user
    validates :name, presence: true, length: {maximum: 60}
    validates :base_currency, inclusion: {in: Finance::Profile::CURRENCIES}
    validates :book_type, inclusion: {in: %w[personal business]}
    validates :month_start_day, numericality: {only_integer: true, in: 1..28}

    def self.default_for(user)
      find_by(user_id: user.id, default_book: true) || create!(user: user, default_book: true,
        name: user.try(:cloud_database_name).presence || "Personal",
        base_currency: Profile.find_by(user_id: user.id)&.currency || "USD")
    rescue ActiveRecord::RecordNotUnique
      find_by!(user_id: user.id, default_book: true)
    end
  end
end
