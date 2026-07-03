"""Native messaging host used by the extension to keep credentials and OTP
retrieval out of the browser's JS layer. The extension drives the actual
login form in the user's normal tab (see extension/content.js) and calls
this host for two things:

  {"action": "get_credentials"}
      -> {"status": "success", "user_id": ..., "password": ...}

  {"action": "answer_security_question", "question": "<question text>"}
      -> {"status": "success", "answer": ...}

  {"action": "mark_otp_watermark"}
      -> {"status": "success", "min_uid": <int>}   (call right before requesting the OTP)

  {"action": "fetch_otp", "min_uid": <int>}
      -> {"status": "success", "otp": "123456"}   (once a mail with UID > min_uid arrives)
      -> {"status": "pending"}                     (not yet — extension retries)

Framed per Chrome's native messaging protocol (4-byte little-endian length
prefix + UTF-8 JSON) on stdin/stdout. This process never touches the browser.
"""

import json
import struct
import sys
import traceback

from erp_credentials import ERP_PASSWORD, ERP_USER_ID, answer_for_question, fetch_otp, get_max_uid


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        sys.exit(0)
    length = struct.unpack("<I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message: dict):
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def handle(request: dict) -> dict:
    action = request.get("action")
    if action == "get_credentials":
        return {"status": "success", "user_id": ERP_USER_ID, "password": ERP_PASSWORD}
    if action == "answer_security_question":
        answer = answer_for_question(request.get("question", ""))
        return {"status": "success", "answer": answer}
    if action == "mark_otp_watermark":
        return {"status": "success", "min_uid": get_max_uid()}
    if action == "fetch_otp":
        # Bounded poll so each native round-trip stays short (keeps the
        # extension's service worker alive); the extension retries on "pending".
        try:
            otp = fetch_otp(min_uid=request.get("min_uid", 0), timeout=10)
        except TimeoutError:
            return {"status": "pending"}
        return {"status": "success", "otp": otp}
    return {"status": "error", "message": f"Unknown action: {action!r}"}


def main():
    # Chrome keeps the native messaging port open across multiple requests
    # per connection; loop until stdin closes (read_message exits on EOF).
    while True:
        request = read_message()
        # Echo requestId so the extension can match this reply to its call.
        request_id = request.get("requestId")
        try:
            response = handle(request)
        except Exception as exc:  # noqa: BLE001 — report any failure back to the extension
            response = {"status": "error", "message": str(exc), "trace": traceback.format_exc()}
        response["requestId"] = request_id
        send_message(response)


if __name__ == "__main__":
    main()
