require "bigdecimal"

module Finance
  # What the dashboard's "Your accounts" section shows: cash accounts (checking and savings read
  # from statements, plus cash the person holds and types in), and credit cards with what is owed.
  # It only arranges numbers BalanceSync already worked out; it never invents a balance.
  class AccountOverview
    def initialize(summary:, profile:)
      @summary = summary
      @profile = profile
    end

    def cash_rows
      rows.select { |row| row[:account].kind == "cash" }
    end

    def credit_rows
      rows.select { |row| row[:account].kind == "credit" }
    end

    # Accounts whose type (cash or credit) still needs to be chosen.
    def unknown_rows
      rows.select { |row| row[:account].kind == "unknown" }
    end

    def bank_cash_total
      @summary[:total]
    end

    def cash_on_hand
      @profile.cash_on_hand.to_d
    end

    # Checking and savings from statements plus cash on hand. Cash on hand counts even when no
    # statement balance is known yet, because the person entered it.
    def total_cash
      (bank_cash_total || BigDecimal(0)) + cash_on_hand
    end

    def cash_total_partial?
      (rows.any? || unassigned_count.positive?) && !@summary[:complete]
    end

    def credit_total
      @summary[:credit_total]
    end

    def credit_count
      @summary[:credit_count].to_i
    end

    def unassigned_count
      Array(@summary[:unassigned_statements]).size
    end

    def credit_balance(row)
      row[:credit_balance]
    end

    private

    def rows
      Array(@summary[:accounts])
    end
  end
end
