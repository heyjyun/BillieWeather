import uvicorn

from billieforecast.config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run("billieforecast.api:app", host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()
