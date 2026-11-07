import sys
from datetime import date
from types import ModuleType

import pytest

from billieforecast.backends import BackendUnavailable, ChronosBackend
from billieforecast.config import Settings
from billieforecast.schemas import DailyCashFlow


@pytest.fixture
def history():
    return [
        DailyCashFlow(date=date(2026, 10, 1), income="30.00", expenses="3.00"),
        DailyCashFlow(date=date(2026, 10, 2), income="60.00", expenses="6.00"),
        DailyCashFlow(date=date(2026, 10, 3), income="0.00", expenses="0.00"),
    ]


def install_fake_chronos(monkeypatch, pipeline_class):
    module = ModuleType("chronos")
    module.Chronos2Pipeline = pipeline_class
    monkeypatch.setitem(sys.modules, "chronos", module)


def test_chronos_groups_income_and_expenses_and_reuses_loaded_pipeline(
    monkeypatch, tmp_path, history
):
    torch = pytest.importorskip("torch")
    load_calls = []
    prediction_calls = []

    class FakePipeline:
        @classmethod
        def from_pretrained(cls, model_id, **kwargs):
            load_calls.append((model_id, kwargs))
            return cls()

        def predict_quantiles(self, **kwargs):
            assert torch.is_inference_mode_enabled()
            prediction_calls.append(kwargs)
            median = torch.tensor([[1.25, 2.50], [3.75, 4.00]])
            return [], [median]

    install_fake_chronos(monkeypatch, FakePipeline)
    backend = ChronosBackend(Settings(device="cpu", cache_dir=tmp_path))
    assert backend.ready is False

    assert backend.predict(history, 2) == ([1.25, 2.50], [3.75, 4.00])
    assert backend.ready is True
    assert backend.predict(history, 2) == ([1.25, 2.50], [3.75, 4.00])

    assert load_calls == [("amazon/chronos-2", {"device_map": "cpu", "cache_dir": str(tmp_path)})]
    assert len(prediction_calls) == 2
    call = prediction_calls[0]
    assert call["prediction_length"] == 2
    assert call["quantile_levels"] == [0.5]
    assert len(call["inputs"]) == 1
    tensor = call["inputs"][0]
    assert tuple(tensor.shape) == (2, 3)
    assert tensor.dtype == torch.float32
    assert tensor.tolist() == [[30.0, 60.0, 0.0], [3.0, 6.0, 0.0]]


def test_failed_model_load_is_a_controlled_error_without_marking_backend_ready(
    monkeypatch, tmp_path, history
):
    pytest.importorskip("torch")

    class UnavailablePipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            raise RuntimeError("private-model-download-token")

    install_fake_chronos(monkeypatch, UnavailablePipeline)
    backend = ChronosBackend(Settings(cache_dir=tmp_path))

    with pytest.raises(BackendUnavailable) as error:
        backend.predict(history, 2)

    assert "private-model-download-token" not in str(error.value)
    assert backend.ready is False


def test_chronos_rejects_an_unexpected_number_of_predicted_variates(monkeypatch, tmp_path, history):
    torch = pytest.importorskip("torch")

    class WrongShapePipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()

        def predict_quantiles(self, **kwargs):
            return [], [torch.zeros((1, 2))]

    install_fake_chronos(monkeypatch, WrongShapePipeline)
    backend = ChronosBackend(Settings(cache_dir=tmp_path))

    with pytest.raises(BackendUnavailable, match="unexpected prediction shape"):
        backend.predict(history, 2)
