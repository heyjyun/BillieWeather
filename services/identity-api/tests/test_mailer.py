"""Postmark delivery: success needs Postmark's own confirmation; transient failures retry; permanent ones don't."""
import httpx
import pytest

from identity_api.mailer import MailError, MailRejected, Message, PostmarkMailer

MESSAGE = Message(to="person@example.org", subject="Your code", text="1234-5678", kind="signup_code")


def mailer_with(responses: list):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        result = responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return PostmarkMailer("server-token", "BillieWeather <hi@example.com>", client=client, sleep=lambda _: None), calls


def ok():
    return httpx.Response(200, json={"ErrorCode": 0, "Message": "OK", "MessageID": "b7bc2f4a-e38e-4336-af7d-e6c392c2f817"})


def test_accepted_message_is_sent_once_with_the_token_header():
    mailer, calls = mailer_with([ok()])
    mailer.send(MESSAGE)
    assert len(calls) == 1 and calls[0].headers["X-Postmark-Server-Token"] == "server-token"


def test_transient_failures_are_retried():
    mailer, calls = mailer_with([httpx.Response(503), httpx.ConnectError("down"), ok()])
    mailer.send(MESSAGE)
    assert len(calls) == 3


def test_persistent_outage_raises_mail_error():
    mailer, calls = mailer_with([httpx.Response(500)] * 3)
    with pytest.raises(MailError) as error:
        mailer.send(MESSAGE)
    assert not isinstance(error.value, MailRejected) and len(calls) == 3


@pytest.mark.parametrize("code", [300, 406])
def test_recipient_rejection_is_permanent_and_not_retried(code):
    mailer, calls = mailer_with([httpx.Response(422, json={"ErrorCode": code, "Message": "rejected"})])
    with pytest.raises(MailRejected):
        mailer.send(MESSAGE)
    assert len(calls) == 1


@pytest.mark.parametrize("response", [
    httpx.Response(401, json={"ErrorCode": 10, "Message": "bad token"}),
    httpx.Response(422, json={"ErrorCode": 400, "Message": "sender signature not confirmed"}),
    httpx.Response(200, json={"ErrorCode": 0}),  # no MessageID: not a confirmed hand-off
    httpx.Response(200, text="not json"),
])
def test_configuration_errors_and_unconfirmed_results_fail_without_retry(response):
    mailer, calls = mailer_with([response])
    with pytest.raises(MailError) as error:
        mailer.send(MESSAGE)
    assert not isinstance(error.value, MailRejected) and len(calls) == 1
