from decimal import Decimal
from threading import Lock
from typing import Protocol

from billieforecast.config import Settings
from billieforecast.schemas import DailyCashFlow

PredictionValue = float | Decimal


class BackendUnavailable(RuntimeError):
    """A controlled error suitable for returning without exposing request data."""


class ForecastBackend(Protocol):
    name: str
    model_id: str | None

    @property
    def ready(self) -> bool: ...

    def predict(
        self, history: list[DailyCashFlow], days: int
    ) -> tuple[list[PredictionValue], list[PredictionValue]]: ...


class AverageBackend:
    name = "average"
    model_id = None
    ready = True

    def predict(
        self, history: list[DailyCashFlow], days: int
    ) -> tuple[list[PredictionValue], list[PredictionValue]]:
        count = len(history)
        income = sum((day.income for day in history), Decimal("0")) / count
        expenses = sum((day.expenses for day in history), Decimal("0")) / count
        return [income] * days, [expenses] * days


class ChronosBackend:
    name = "chronos"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = settings.model_id
        self._pipeline = None
        self._lock = Lock()

    @property
    def ready(self) -> bool:
        return self._pipeline is not None

    def _load(self) -> None:
        if self._pipeline is not None:
            return
        try:
            from chronos import Chronos2Pipeline
        except ImportError as error:
            raise BackendUnavailable(
                "Chronos dependencies are unavailable. Run uv sync --extra chronos."
            ) from error
        try:
            self._pipeline = Chronos2Pipeline.from_pretrained(
                self.model_id,
                device_map=self.settings.device,
                cache_dir=str(self.settings.cache_dir),
            )
        except Exception as error:
            raise BackendUnavailable(
                "Chronos model could not be loaded. Check model files, device, and network access."
            ) from error

    def predict(self, history: list[DailyCashFlow], days: int) -> tuple[list[float], list[float]]:
        # Keep one model per process and serialize CPU/GPU inference and lazy initialization.
        with self._lock:
            self._load()
            import torch

            values = torch.tensor(
                [[float(day.income) for day in history], [float(day.expenses) for day in history]],
                dtype=torch.float32,
            )
            # A single (variates, history) tensor groups income and expenses together.
            # Chronos-2 calls the second return value "mean", but it is the median.
            with torch.inference_mode():
                _, median = self._pipeline.predict_quantiles(
                    inputs=[values], prediction_length=days, quantile_levels=[0.5]
                )
            predictions = median[0].detach().cpu()
            if tuple(predictions.shape) != (2, days):
                raise BackendUnavailable("Chronos returned an unexpected prediction shape.")
            return predictions[0].tolist(), predictions[1].tolist()
