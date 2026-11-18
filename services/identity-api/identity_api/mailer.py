"""Transactional email: the sign-up code and the "you already have an account" notice.

Deliveries: postmark (production; same POSTMARK_API_TOKEN / MAIL_FROM names as the Rails app),
outbox (development: one JSON file per message under MAIL_OUTBOX_DIR, never in logs) and memory
(tests). Message bodies are never logged.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

log = logging.getLogger("identity_api.mailer")


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    text: str
    kind: str


class Mailer(Protocol):
    def send(self, message: Message) -> None: ...


class MailError(Exception):
    """Delivery failed for a reason that may pass (provider down, network, rate limit)."""


class MailRejected(MailError):
    """The provider permanently refused this recipient (invalid address, inactive/bounced)."""


# Postmark API error codes that will not change on retry for this recipient:
# 300 invalid email request, 406 inactive recipient (hard bounce, spam complaint, suppression).
# https://postmarkapp.com/developer/api/overview#error-codes
_RECIPIENT_REJECTED = {300, 406}


class PostmarkMailer:
    """Synchronous send through Postmark's HTTPS API. A call returns only after Postmark has
    accepted the message (ErrorCode 0 and a MessageID), so the client never says "we emailed"
    for a message that was not handed to the provider. Transient failures are retried briefly."""

    ENDPOINT = "https://api.postmarkapp.com/email"
    ATTEMPTS = 3

    def __init__(self, token: str, sender: str, client: httpx.Client | None = None, sleep=time.sleep):  # noqa: ANN001
        self.token = token
        self.sender = sender
        self.client = client or httpx.Client(timeout=10.0)
        self.sleep = sleep

    def send(self, message: Message) -> None:
        payload = {"From": self.sender, "To": message.to, "Subject": message.subject, "TextBody": message.text,
                   "MessageStream": "outbound", "Tag": f"identity-{message.kind}", "TrackOpens": False, "TrackLinks": "None"}
        for attempt in range(1, self.ATTEMPTS + 1):
            status: int | None = None
            error_code: int | None = None
            try:
                response = self.client.post(self.ENDPOINT, json=payload,
                                            headers={"X-Postmark-Server-Token": self.token, "Accept": "application/json"})
                status = response.status_code
                try:
                    result = response.json()
                except ValueError:
                    result = {}
                error_code = result.get("ErrorCode") if isinstance(result, dict) else None
                message_id = result.get("MessageID") if isinstance(result, dict) else None
                if status == 200 and error_code == 0 and isinstance(message_id, str) and message_id:
                    log.info("mail_accepted kind=%s message_id=%s attempt=%s", message.kind, message_id, attempt)
                    return
                if status == 422 and error_code in _RECIPIENT_REJECTED:
                    log.warning("mail_rejected kind=%s status=%s error_code=%s", message.kind, status, error_code)
                    raise MailRejected(message.kind)
                transient = status == 429 or status >= 500
            except httpx.HTTPError:
                transient = True
            # 401/422 (bad token, unverified sender signature, ...) are configuration errors: no retry.
            log.error("mail_delivery_failed kind=%s status=%s error_code=%s attempt=%s", message.kind, status, error_code, attempt)
            if not transient or attempt == self.ATTEMPTS:
                raise MailError(message.kind)
            self.sleep(0.5 * attempt)
        raise MailError(message.kind)  # pragma: no cover


class OutboxMailer:
    def __init__(self, directory: str):
        self.directory = Path(directory)

    def send(self, message: Message) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / f"{int(time.time() * 1000)}-{message.kind}-{uuid.uuid4().hex[:8]}.json"
        path.write_text(json.dumps(message.__dict__, ensure_ascii=False, indent=2))
        # Development only: nothing is emailed. The path (never the code) is logged so the developer can find it.
        log.warning("mail_not_sent_written_to_outbox kind=%s path=%s", message.kind, path.resolve())


@dataclass
class MemoryMailer:
    sent: list[Message] = field(default_factory=list)
    fail: bool = False
    reject: bool = False

    def send(self, message: Message) -> None:
        if self.reject:
            raise MailRejected(message.kind)
        if self.fail:
            raise MailError(message.kind)
        self.sent.append(message)


# --- localized copy -------------------------------------------------------------------------

_COPY: dict[str, dict[str, str]] = {
    "en": {
        "code_subject": "Your BillieWeather verification code: {code}",
        "code_body": "Enter this code in the BillieWeather app to finish creating your account:\n\n    {code}\n\nThe code expires in {minutes} minutes. If you did not try to create a BillieWeather account, you can ignore this email; no account is created without the code.",
        "exists_subject": "You already have a BillieWeather account",
        "exists_body": "Someone (hopefully you) tried to create a BillieWeather account with this email address, but an account already exists.\n\nSign in with your password in the app. If you forgot it, use \"Forgot your password?\" on the sign-in screen.\n\nIf this wasn't you, you can ignore this email. Nothing about your account has changed.",
    },
    "zh-CN": {
        "code_subject": "你的 BillieWeather 验证码：{code}",
        "code_body": "请在 BillieWeather 应用中输入以下验证码以完成注册：\n\n    {code}\n\n验证码将在 {minutes} 分钟后失效。如果这不是你本人的操作，请忽略此邮件；没有验证码就不会创建账户。",
        "exists_subject": "你已经有 BillieWeather 账户了",
        "exists_body": "有人（希望是你）尝试用此邮箱注册 BillieWeather，但这个邮箱已经有账户。\n\n请在应用中用密码登录。如果忘记密码，请在登录页点击“忘记密码？”。\n\n如果这不是你本人的操作，请忽略此邮件，你的账户没有任何变化。",
    },
    "zh-TW": {
        "code_subject": "你的 BillieWeather 驗證碼：{code}",
        "code_body": "請在 BillieWeather 應用程式中輸入以下驗證碼以完成註冊：\n\n    {code}\n\n驗證碼將在 {minutes} 分鐘後失效。如果這不是你本人的操作，請忽略此郵件；沒有驗證碼就不會建立帳戶。",
        "exists_subject": "你已經有 BillieWeather 帳戶了",
        "exists_body": "有人（希望是你）嘗試用此信箱註冊 BillieWeather，但這個信箱已經有帳戶。\n\n請在應用程式中用密碼登入。如果忘記密碼，請在登入頁點選「忘記密碼？」。\n\n如果這不是你本人的操作，請忽略此郵件，你的帳戶沒有任何變化。",
    },
    "ja": {
        "code_subject": "BillieWeather 確認コード：{code}",
        "code_body": "BillieWeather アプリに次のコードを入力して、アカウント作成を完了してください。\n\n    {code}\n\nこのコードの有効期限は {minutes} 分です。お心当たりがない場合はこのメールを無視してください。コードがなければアカウントは作成されません。",
        "exists_subject": "BillieWeather アカウントはすでに登録されています",
        "exists_body": "このメールアドレスで BillieWeather アカウントの作成が試みられましたが、すでにアカウントが存在します。\n\nアプリでパスワードを使ってログインしてください。パスワードをお忘れの場合は、ログイン画面の「パスワードをお忘れですか？」をご利用ください。\n\nお心当たりがない場合はこのメールを無視してください。アカウントには何も変更されていません。",
    },
    "ko": {
        "code_subject": "BillieWeather 인증 코드: {code}",
        "code_body": "BillieWeather 앱에 다음 코드를 입력해 계정 만들기를 완료하세요.\n\n    {code}\n\n코드는 {minutes}분 후에 만료됩니다. 본인이 요청하지 않았다면 이 이메일을 무시하세요. 코드 없이는 계정이 만들어지지 않습니다.",
        "exists_subject": "이미 BillieWeather 계정이 있습니다",
        "exists_body": "누군가(본인이길 바랍니다) 이 이메일 주소로 BillieWeather 계정을 만들려고 했지만, 이미 계정이 있습니다.\n\n앱에서 비밀번호로 로그인하세요. 비밀번호를 잊으셨다면 로그인 화면의 \"비밀번호를 잊으셨나요?\"를 사용하세요.\n\n본인이 아니라면 이 이메일을 무시하세요. 계정에는 아무 변화도 없습니다.",
    },
    "es": {
        "code_subject": "Tu código de verificación de BillieWeather: {code}",
        "code_body": "Introduce este código en la aplicación BillieWeather para terminar de crear tu cuenta:\n\n    {code}\n\nEl código caduca en {minutes} minutos. Si no intentaste crear una cuenta de BillieWeather, ignora este correo; sin el código no se crea ninguna cuenta.",
        "exists_subject": "Ya tienes una cuenta de BillieWeather",
        "exists_body": "Alguien (esperamos que tú) intentó crear una cuenta de BillieWeather con este correo, pero ya existe una cuenta.\n\nInicia sesión con tu contraseña en la aplicación. Si la olvidaste, usa \"¿Olvidaste tu contraseña?\" en la pantalla de inicio de sesión.\n\nSi no fuiste tú, ignora este correo. Tu cuenta no ha cambiado.",
    },
}


def _copy(locale: str | None) -> dict[str, str]:
    return _COPY.get(locale or "en", _COPY["en"])


def format_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def code_message(to: str, code: str, minutes: int, locale: str | None) -> Message:
    copy = _copy(locale)
    shown = format_code(code)
    return Message(to=to, subject=copy["code_subject"].format(code=shown), text=copy["code_body"].format(code=shown, minutes=minutes), kind="signup_code")


def existing_account_message(to: str, locale: str | None) -> Message:
    copy = _copy(locale)
    return Message(to=to, subject=copy["exists_subject"], text=copy["exists_body"], kind="existing_account")


def build_mailer(settings) -> Mailer:  # noqa: ANN001
    if settings.mail_delivery == "postmark":
        return PostmarkMailer(settings.postmark_api_token, settings.mail_from)
    if settings.mail_delivery == "memory":
        return MemoryMailer()
    return OutboxMailer(settings.mail_outbox_dir)
