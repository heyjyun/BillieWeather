from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

Money = Annotated[Decimal, Field(max_digits=16, decimal_places=2, allow_inf_nan=False)]
NonnegativeMoney = Annotated[Money, Field(ge=0)]
Adjustment = Annotated[Decimal, Field(ge=-100, le=1000, allow_inf_nan=False)]


class DailyCashFlow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: date
    income: NonnegativeMoney
    expenses: NonnegativeMoney


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    history: list[DailyCashFlow] = Field(min_length=3, max_length=90)
    starting_balance: Money
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    days: int = Field(default=30, ge=1, le=90, strict=True)
    income_adjustment: Adjustment = Decimal("0")
    expense_adjustment: Adjustment = Decimal("0")

    @model_validator(mode="after")
    def consecutive_dates(self) -> Self:
        for previous, current in zip(self.history, self.history[1:], strict=False):
            if current.date != previous.date + timedelta(days=1):
                raise ValueError(
                    "History dates must be ordered, unique, and consecutive daily dates"
                )
        if self.history[-1].date > date.max - timedelta(days=self.days):
            raise ValueError("Forecast dates exceed the supported date range")
        return self


class ForecastPoint(BaseModel):
    date: date
    income: Decimal
    expenses: Decimal
    net_flow: Decimal
    balance: Decimal


class ForecastResponse(BaseModel):
    provider: str
    model: str | None
    currency: str
    balance_as_of: date
    starting_balance: Decimal
    projected_balance: Decimal
    history_days: int
    days: int
    income_adjustment: Decimal
    expense_adjustment: Decimal
    points: list[ForecastPoint]
    warnings: list[str]
    assumptions: list[str]
