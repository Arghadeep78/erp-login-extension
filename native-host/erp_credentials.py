"""Shared helpers used by native_host.py: security-question answer lookup and
OTP retrieval via IMAP. The actual login form is driven by the browser
extension (extension/content.js), not from here.
"""

import email
import imaplib
import os
import re
import time

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

ERP_USER_ID = os.environ["ERP_USER_ID"]
ERP_PASSWORD = os.environ["ERP_PASSWORD"]

IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
IMAP_EMAIL = os.environ["IMAP_EMAIL"]
IMAP_APP_PASSWORD = os.environ["IMAP_APP_PASSWORD"]

SECURITY_ANSWERS = []
for i in range(1, 10):
    match = os.environ.get(f"SECQ_QUESTION_{i}")
    answer = os.environ.get(f"SECQ_ANSWER_{i}")
    if match and answer:
        SECURITY_ANSWERS.append((match.lower(), answer))

# Reused across calls (both within one fetch_otp poll loop and across the
# extension's separate fetch_otp native calls, since this process stays alive
# for the whole login) so we don't open a fresh TLS connection + login every
# few seconds — Gmail throttles/flags accounts for rapid repeated app-password
# logins from the same IP.
_imap_conn = None


def answer_for_question(question_text: str) -> str:
    q = question_text.strip().lower()
    for match, answer in SECURITY_ANSWERS:
        if match == q:
            return answer
    raise RuntimeError(f"No stored answer matches security question: {question_text!r}")


def _get_imap() -> imaplib.IMAP4_SSL:
    """Return the cached IMAP connection, reconnecting if there isn't one yet
    or the cached one has gone dead (e.g. server-side idle timeout)."""
    global _imap_conn
    if _imap_conn is not None:
        try:
            _imap_conn.noop()
            return _imap_conn
        except Exception:
            try:
                _imap_conn.logout()
            except Exception:
                pass
            _imap_conn = None
    imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    imap.login(IMAP_EMAIL, IMAP_APP_PASSWORD)
    imap.select("INBOX")
    _imap_conn = imap
    return imap


def get_max_uid() -> int:
    """Return the highest UID currently in INBOX, to use as a watermark: only
    messages with a UID greater than this were received after this call, with
    no dependence on comparing this machine's clock to the mail server's."""
    imap = _get_imap()
    status, data = imap.uid("search", None, "ALL")
    uids = data[0].split() if status == "OK" else []
    return int(uids[-1]) if uids else 0


def fetch_otp(min_uid: int, timeout: int = 90) -> str:
    """Poll the mailbox for an OTP email with UID > min_uid and extract the code."""
    global _imap_conn
    deadline = time.time() + timeout
    while time.time() < deadline:
        imap = _get_imap()  # raises immediately on bad login — not caught below
        try:
            status, data = imap.uid("search", None, f"(UID {min_uid + 1}:* FROM \"iitkgp.ac.in\")")
            uids = data[0].split() if status == "OK" else []
            for msg_uid in reversed(uids):
                if int(msg_uid) <= min_uid:
                    continue
                status, msg_data = imap.uid("fetch", msg_uid, "(RFC822)")
                if status != "OK" or not msg_data or msg_data[0] is None:
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                subject = msg.get("Subject", "")
                body = _get_body(msg)
                text = f"{subject}\n{body}"
                match = re.search(r"\b(\d{4,8})\b", text)
                if ("otp" in text.lower() or "one time password" in text.lower()) and match:
                    return match.group(1)
        except (imaplib.IMAP4.error, OSError):
            # Transient blip (dropped connection, network hiccup) mid-poll — drop the
            # cached connection so the next iteration reconnects, and keep polling
            # rather than letting this escape and abort the whole fetch_otp call.
            _imap_conn = None
        time.sleep(1)
    raise TimeoutError("OTP email not received within timeout")


def _get_body(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                return part.get_payload(decode=True).decode(errors="ignore")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                return part.get_payload(decode=True).decode(errors="ignore")
        return ""
    return msg.get_payload(decode=True).decode(errors="ignore")
