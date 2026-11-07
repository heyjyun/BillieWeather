from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BILLIEFORECAST_", env_file=".env", extra="ignore")

    backend: Literal["chronos", "average"] = "chronos"
    model_id: str = "amazon/chronos-2"
    device: Literal["cpu", "cuda"] = "cpu"
    cache_dir: Path = Path(".cache/huggingface")
    api_key: str | None = None
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)

    @field_validator("api_key", mode="before")
    @classmethod
    def blank_key_is_unset(cls, value: str | None) -> str | None:
        return value or None
