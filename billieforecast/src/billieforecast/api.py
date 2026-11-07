import logging
import secrets
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from billieforecast import __version__
from billieforecast.backends import (
    AverageBackend,
    BackendUnavailable,
    ChronosBackend,
    ForecastBackend,
)
from billieforecast.config import Settings
from billieforecast.forecast import generate_forecast
from billieforecast.schemas import ForecastRequest, ForecastResponse

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, backend: ForecastBackend | None = None) -> FastAPI:
    if settings is None:
        settings = Settings()
    if backend is None:
        backend = AverageBackend() if settings.backend == "average" else ChronosBackend(settings)

    application = FastAPI(
        title="BillieForecast",
        version=__version__,
        description="Local cash-flow forecasting using Chronos-2 or an explicit average baseline.",
    )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request, error: RequestValidationError) -> JSONResponse:
        # Report invalid fields without echoing financial values or invalid JSON NaN tokens.
        errors = [{key: item[key] for key in ("loc", "msg", "type")} for item in error.errors()]
        return JSONResponse(status_code=422, content={"detail": errors})

    def authorize(x_api_key: Annotated[str | None, Header()] = None) -> None:
        if settings.api_key and (
            x_api_key is None
            or not secrets.compare_digest(x_api_key.encode(), settings.api_key.encode())
        ):
            raise HTTPException(status_code=401, detail="A valid X-API-Key is required.")

    @application.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "version": __version__,
            "backend": backend.name,
            "model_loaded": backend.ready,
        }

    @application.get("/ready")
    def ready() -> JSONResponse:
        return JSONResponse(
            status_code=200 if backend.ready else 503,
            content={"ready": backend.ready, "backend": backend.name},
        )

    @application.post(
        "/v1/forecast", response_model=ForecastResponse, dependencies=[Depends(authorize)]
    )
    def forecast(request: ForecastRequest) -> ForecastResponse:
        try:
            return generate_forecast(request, backend)
        except BackendUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from None
        except Exception as error:
            # Do not log financial payloads, API keys, or potentially sensitive library errors.
            logger.error("Forecast backend failed (%s)", type(error).__name__)
            raise HTTPException(
                status_code=503,
                detail="Forecast backend unavailable. Check model installation and configuration.",
            ) from None

    return application


app = create_app()
