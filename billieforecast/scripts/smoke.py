"""Exercise the running service with synthetic daily data, never bank records."""

import argparse
import json
import os
import sys
from datetime import date, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    last_day = date.today() - timedelta(days=1)
    history = []
    for offset in range(90):
        day = last_day - timedelta(days=89 - offset)
        history.append(
            {
                "date": day.isoformat(),
                "income": "2500.00" if day.day in (1, 15) else "0.00",
                "expenses": "1200.00" if day.day == 1 else "45.00",
            }
        )
    payload = {
        "history": history,
        "starting_balance": "5000.00",
        "currency": "USD",
        "days": 30,
    }
    headers = {"Content-Type": "application/json"}
    if os.getenv("BILLIEFORECAST_API_KEY"):
        headers["X-API-Key"] = os.environ["BILLIEFORECAST_API_KEY"]
    request = Request(
        args.url.rstrip("/") + "/v1/forecast",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=600) as response:
            result = json.load(response)
    except HTTPError as error:
        print(error.read().decode(), file=sys.stderr)
        sys.exit(1)
    except URLError as error:
        print(f"Cannot reach BillieForecast: {error.reason}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, indent=2))
    if len(result.get("points", [])) != payload["days"]:
        sys.exit("Unexpected number of forecast points")


if __name__ == "__main__":
    main()
