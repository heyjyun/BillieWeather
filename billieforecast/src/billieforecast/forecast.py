import math
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from billieforecast.backends import BackendUnavailable, ForecastBackend
from billieforecast.schemas import ForecastPoint, ForecastRequest, ForecastResponse

CENT = Decimal("0.01")


def cents(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def generate_forecast(request: ForecastRequest, backend: ForecastBackend) -> ForecastResponse:
    incomes, expenses = backend.predict(request.history, request.days)
    if len(incomes) != request.days or len(expenses) != request.days:
        raise BackendUnavailable("Forecast backend returned an unexpected number of predictions.")
    if not all(math.isfinite(value) for value in [*incomes, *expenses]):
        raise BackendUnavailable("Forecast backend returned non-finite predictions.")

    income_factor = 1 + request.income_adjustment / 100
    expense_factor = 1 + request.expense_adjustment / 100
    balance = cents(request.starting_balance)
    anchor_date = request.history[-1].date
    points = []
    negative_predictions = False
    for offset, (raw_income, raw_expense) in enumerate(
        zip(incomes, expenses, strict=True), start=1
    ):
        negative_predictions |= raw_income < 0 or raw_expense < 0
        income = cents(Decimal(str(max(0.0, raw_income))) * income_factor)
        expense = cents(Decimal(str(max(0.0, raw_expense))) * expense_factor)
        net_flow = income - expense
        balance += net_flow
        points.append(
            ForecastPoint(
                date=anchor_date + timedelta(days=offset),
                income=income,
                expenses=expense,
                net_flow=net_flow,
                balance=balance,
            )
        )

    warnings = []
    if len(request.history) < 30:
        warnings.append("Fewer than 30 days of history; recurring monthly patterns may be missed.")
    if negative_predictions:
        warnings.append("Negative income or expense predictions were clipped to zero.")
    if backend.name == "average":
        warnings.append("Average mode is active; this forecast was not produced by Chronos-2.")

    return ForecastResponse(
        provider=backend.name,
        model=backend.model_id,
        currency=request.currency,
        balance_as_of=anchor_date,
        starting_balance=cents(request.starting_balance),
        projected_balance=balance,
        history_days=len(request.history),
        days=request.days,
        income_adjustment=request.income_adjustment,
        expense_adjustment=request.expense_adjustment,
        points=points,
        warnings=warnings,
        assumptions=[
            "Starting balance is supplied by the caller as of the last history date; "
            "it is not inferred from transactions or fetched from a bank.",
            "History contains consecutive fully covered days; true no-transaction days are zero. "
            "Transfers and excluded transactions must be removed by the caller.",
            "Income and expenses are predicted separately and adjusted by scenario percentages. "
            "Negative predictions are clipped to zero; daily amounts are rounded to cents.",
            "Projected balances accumulate daily point forecasts. They are not calibrated "
            "balance quantiles and do not include confirmed future bills or payments.",
        ],
    )
