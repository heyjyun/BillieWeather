module Finance
  # Projection for the shared deterministic policy in public/next-steps.mjs.
  class NextStepFacts
    def self.for(user, profile, today)
      accounts = user.finance_bank_accounts.ordered.to_a
      entries = user.finance_transactions.live
      scoped = OverviewData.in_currency(entries.where(excluded: false), profile.currency, profile.currency).where(booked_on: (today - 1.year)..today)
      counted = scoped.included
      recent = scoped.where(kind: %w[expense card_payment transfer]).order(booked_on: :desc, id: :desc)
        .limit(120).pluck(:id, :booked_on, :description, :kind, :amount)
      months = counted.expense_kind.where(booked_on: ...today.beginning_of_month)
        .group(Arel.sql("to_char(booked_on, 'YYYY-MM')")).sum(:amount).transform_values { |amount| (-100 * amount).to_i }
      active_days = counted.where(booked_on: (today - 89)..today).distinct.pluck(:booked_on).sort
      ready = profile.balance_available? && active_days.size >= 3 && (active_days.last - active_days.first) >= 13 && active_days.last >= today - 45
      forecast = CashFlowForecast.new(user: user, engine: "linear").to_h if ready
      shortfall = forecast&.fetch(:points)&.drop(1)&.find { |point| point[:balance].negative? }
      links = user.finance_transaction_links.suggested.joins(:from_transaction).merge(Transaction.live)
      overview = OverviewData.new(user: user, profile: profile, accounts: accounts, account: nil, currency: profile.currency, period: nil, today: today)
      observations = BalanceSync.reconciliation_evidence(user)
      {accounts: accounts.map { |a| {id: a.id, name: a.display_name, institution: a.bank_name, pending: a.balance_pending?, observation: (observations[a.id]&.then { |row| [row[:as_of].iso8601, profile.currency, row[:balance].to_s("F")].join(" · ") }), archived: a.archived?} },
       transactions: entries.count, latest: entries.where(booked_on: ..today).maximum(:booked_on)&.iso8601, statements: user.finance_statements.count, unclassified: entries.included.where(category: Transaction::UNCATEGORIZED, kind: %w[income expense refund]).count,
       duplicates: links.where(link_type: "duplicate_of").count, matches: TransferReview.new(user).candidates.size,
       budgets: user.finance_budgets.count, remaining: overview.budget, scheduled: user.finance_recurring_rules.pluck(:name),
       currency: profile.currency, months: months, forecastReady: ready, shortfall: shortfall&.fetch(:date)&.iso8601,
       recent: recent.map { |id, date, description, kind, amount| {id: id, date: date.iso8601, description: description, kind: kind, cents: (amount * 100).to_i} },
       available: %w[account import classify duplicates reconcile discover budget recurring forecast report matches]}
    end
  end
end
