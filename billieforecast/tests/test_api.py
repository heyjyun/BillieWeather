import json
from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from billieforecast.api import create_app
from billieforecast.config import Settings


@pytest.fixture
def payload():
    return {
        "starting_balance": "100.00",
        "currency": "USD",
        "days": 2,
        "history": [
            {"date": "2026-10-01", "income": "30.00", "expenses": "3.00"},
            {"date": "2026-10-02", "income": "60.00", "expenses": "6.00"},
            {"date": "2026-10-03", "income": "0.00", "expenses": "0.00"},
        ],
    }


@pytest.fixture
def client():
    with TestClient(create_app(settings=Settings(backend="average"))) as test_client:
        yield test_client


class FakeChronosBackend:
    name = "chronos"
    model_id = "amazon/chronos-2"

    def __init__(self, *, ready=True, income=30.0, expenses=3.0):
        self.ready = ready
        self.income = income
        self.expenses = expenses
        self.calls = 0

    def predict(self, history, days):
        self.calls += 1
        self.ready = True
        return [self.income] * days, [self.expenses] * days


def test_average_counts_zero_transaction_days_and_accumulates_cash(client, payload):
    response = client.post("/v1/forecast", json=payload)

    assert response.status_code == 200
    result = response.json()
    assert result["provider"] == "average"
    assert result["model"] is None
    assert result["balance_as_of"] == "2026-10-03"
    assert result["currency"] == "USD"
    assert result["history_days"] == 3
    assert result["days"] == 2
    assert isinstance(result["projected_balance"], str)
    assert Decimal(result["starting_balance"]) == Decimal("100.00")
    assert Decimal(result["projected_balance"]) == Decimal("154.00")
    assert [point["date"] for point in result["points"]] == [
        "2026-10-04",
        "2026-10-05",
    ]
    assert [Decimal(point["balance"]) for point in result["points"]] == [
        Decimal("127.00"),
        Decimal("154.00"),
    ]
    assert all(Decimal(point["income"]) == 30 for point in result["points"])
    assert all(Decimal(point["expenses"]) == 3 for point in result["points"])
    assert all(Decimal(point["net_flow"]) == 27 for point in result["points"])
    assert result["warnings"]
    assert result["assumptions"]


def test_income_and_expense_scenarios_change_only_forecast(client, payload):
    original_history = deepcopy(payload["history"])
    payload.update(income_adjustment=-100, expense_adjustment=100)

    result = client.post("/v1/forecast", json=payload).json()

    assert Decimal(result["projected_balance"]) == Decimal("88.00")
    assert Decimal(result["points"][0]["income"]) == 0
    assert Decimal(result["points"][0]["expenses"]) == 6
    assert payload["history"] == original_history


def test_negative_starting_balance_and_numeric_money_are_supported(client, payload):
    payload["starting_balance"] = -100.50
    payload["history"][0].update(income=30, expenses=3.0)

    response = client.post("/v1/forecast", json=payload)

    assert response.status_code == 200
    assert Decimal(response.json()["projected_balance"]) == Decimal("-46.50")


def test_prediction_rounding_is_half_up_before_cash_is_accumulated(payload):
    backend = FakeChronosBackend(income=0.005, expenses=0.015)
    with TestClient(create_app(settings=Settings(backend="chronos"), backend=backend)) as client:
        response = client.post("/v1/forecast", json=payload)

    assert response.status_code == 200
    result = response.json()
    assert result["provider"] == "chronos"
    assert result["model"] == "amazon/chronos-2"
    assert Decimal(result["points"][0]["income"]) == Decimal("0.01")
    assert Decimal(result["points"][0]["expenses"]) == Decimal("0.02")
    assert Decimal(result["points"][0]["net_flow"]) == Decimal("-0.01")
    assert Decimal(result["projected_balance"]) == Decimal("99.98")


@pytest.mark.parametrize("days", [0, 91, -1, "not-a-number"])
def test_invalid_horizons_are_rejected(client, payload, days):
    payload["days"] = days
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize("field", ["income_adjustment", "expense_adjustment"])
@pytest.mark.parametrize("value", [-101, 1001, "NaN", "Infinity"])
def test_invalid_scenario_adjustments_are_rejected(client, payload, field, value):
    payload[field] = value
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize("currency", ["usd", "US", "USDD", "123"])
def test_currency_must_be_three_uppercase_letters(client, payload, currency):
    payload["currency"] = currency
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize("field", ["income", "expenses"])
@pytest.mark.parametrize("value", ["-0.01", "0.001", "NaN", "Infinity", "-Infinity"])
def test_history_requires_finite_nonnegative_cent_amounts(client, payload, field, value):
    payload["history"][0][field] = value
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize("value", ["0.001", "NaN", "Infinity", "100000000000000.00"])
def test_starting_balance_rejects_invalid_precision_or_nonfinite_values(client, payload, value):
    payload["starting_balance"] = value
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize(
    "dates",
    [
        ["2026-10-01", "2026-10-02", "2026-10-04"],
        ["2026-10-01", "2026-10-02", "2026-10-02"],
        ["2026-10-03", "2026-10-02", "2026-10-01"],
        ["2026-10-01", "invalid-date", "2026-10-03"],
    ],
)
def test_history_dates_must_be_valid_ordered_unique_and_contiguous(client, payload, dates):
    for point, day in zip(payload["history"], dates, strict=True):
        point["date"] = day
    assert client.post("/v1/forecast", json=payload).status_code == 422


@pytest.mark.parametrize("history_days", [0, 2, 91])
def test_history_length_is_bounded(client, payload, history_days):
    payload["history"] = [
        {
            "date": (date(2026, 7, 1) + timedelta(days=index)).isoformat(),
            "income": "0.00",
            "expenses": "0.00",
        }
        for index in range(history_days)
    ]
    assert client.post("/v1/forecast", json=payload).status_code == 422


def test_zero_history_amounts_keep_cash_balance_constant(client, payload):
    for point in payload["history"]:
        point.update(income="0.00", expenses="0.00")

    response = client.post("/v1/forecast", json=payload)

    assert response.status_code == 200
    assert all(Decimal(point["balance"]) == 100 for point in response.json()["points"])


def test_api_key_is_required_only_when_configured(payload):
    with TestClient(
        create_app(settings=Settings(backend="average", api_key="local-test-key"))
    ) as client:
        assert client.get("/health").status_code == 200
        assert client.post("/v1/forecast", json=payload).status_code == 401
        assert (
            client.post(
                "/v1/forecast", json=payload, headers={"X-API-Key": "wrong-key"}
            ).status_code
            == 401
        )
        response = client.post(
            "/v1/forecast", json=payload, headers={"X-API-Key": "local-test-key"}
        )
        assert response.status_code == 200


def test_liveness_and_readiness_do_not_claim_an_unloaded_model_is_ready(payload):
    backend = FakeChronosBackend(ready=False)
    with TestClient(create_app(settings=Settings(backend="chronos"), backend=backend)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["model_loaded"] is False
        assert client.get("/ready").status_code == 503
        assert backend.calls == 0

        assert client.post("/v1/forecast", json=payload).status_code == 200
        assert client.get("/health").json()["model_loaded"] is True
        assert client.get("/ready").status_code == 200


def test_failed_chronos_request_returns_503_without_silent_average_fallback(payload):
    class BrokenBackend(FakeChronosBackend):
        def predict(self, history, days):
            raise RuntimeError("sensitive-provider-error")

    with TestClient(
        create_app(settings=Settings(backend="chronos"), backend=BrokenBackend())
    ) as client:
        response = client.post("/v1/forecast", json=payload)

    assert response.status_code == 503
    assert "sensitive-provider-error" not in response.text
    assert "points" not in response.json()


@pytest.mark.parametrize(
    "bad_output",
    [
        ([], []),
        ([1.0, 1.0], [1.0]),
        ([float("nan"), 1.0], [1.0, 1.0]),
        ([1.0, 1.0], [float("inf"), 1.0]),
    ],
)
def test_invalid_model_outputs_fail_explicitly_instead_of_corrupting_cash(payload, bad_output):
    class InvalidBackend(FakeChronosBackend):
        def predict(self, history, days):
            return bad_output

    with TestClient(
        create_app(settings=Settings(backend="chronos"), backend=InvalidBackend())
    ) as client:
        assert client.post("/v1/forecast", json=payload).status_code == 503


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_raw_nonfinite_json_values_return_validation_errors(client, payload, value):
    payload["history"][0]["income"] = value

    response = client.post(
        "/v1/forecast",
        content=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert "detail" in response.json()
    assert "NaN" not in response.text
    assert "Infinity" not in response.text
