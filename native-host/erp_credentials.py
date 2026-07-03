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
    match = os.environ.get(f"SECQ_ANSWER_{i}_MATCH")
    answer = os.environ.get(f"SECQ_ANSWER_{i}")
    if match and answer:
        SECURITY_ANSWERS.append((match.lower(), answer))


def answer_for_question(question_text: str) -> str:
    q = question_text.lower()
    for match, answer in SECURITY_ANSWERS:
        if match in q:
            return answer
    raise RuntimeError(f"No stored answer matches security question: {question_text!r}")


def fetch_otp(after_ts: float, timeout: int = 90) -> str:
    """Poll the mailbox for the OTP email received after after_ts and extract the code."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        try:
            imap.login(IMAP_EMAIL, IMAP_APP_PASSWORD)
            imap.select("INBOX")
            status, data = imap.search(None, '(FROM "iitkgp.ac.in")')
            ids = data[0].split() if status == "OK" else []
            for msg_id in reversed(ids[-10:]):
                status, msg_data = imap.fetch(msg_id, "(RFC822)")
                if status != "OK":
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                msg_ts = email.utils.mktime_tz(email.utils.parsedate_tz(msg["Date"]))
                if msg_ts < after_ts - 30:
                    continue
                subject = msg.get("Subject", "")
                body = _get_body(msg)
                text = f"{subject}\n{body}"
                match = re.search(r"\b(\d{4,8})\b", text)
                if ("otp" in text.lower() or "one time password" in text.lower()) and match:
                    return match.group(1)
        finally:
            imap.logout()
        time.sleep(3)
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
