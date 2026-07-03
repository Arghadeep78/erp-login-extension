# erp-auto-login

One-click login to IIT KGP ERP from a browser extension: fills ID/password,
answers the (random) security question, fetches the email OTP automatically,
and submits — all in a normal tab of your own browser window. No separate
automated browser window opens.

## How it works

- `extension/` — the browser extension. `content.js` drives the actual login
  form in your current tab; `background.js` relays a few short calls to the
  native host and opens/reuses the ERP tab.
- `native-host/` — a local Python helper the browser launches on demand
  (Chrome's [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  API). It never touches the browser directly — it only answers three
  questions: your credentials, the answer to a given security question, and
  the OTP (fetched by polling your inbox over IMAP). Nothing is a
  long-running server; the browser starts and stops the process per use.

All secrets live only in your local `.env` — nothing is sent anywhere except
to the ERP site itself and your own mail provider.

## Setup (do this once after cloning)

**1. Don't put this project in `~/Desktop`, `~/Documents`, or `~/Downloads`.**
macOS blocks browsers from launching anything in those folders, and the
extension will fail with "Native host has exited". Clone it anywhere else,
e.g. `~/erp-auto-login`.

**2. Install the Python dependencies** (used by the native host):

macOS/Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows (PowerShell):
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**3. Configure your credentials:**

```bash
cp .env.example .env
```

Edit `.env` (quote values with spaces/special characters, e.g. `"@123456"`):
- `ERP_USER_ID`, `ERP_PASSWORD` — your ERP login.
- `SECQ_ANSWER_1..3_MATCH` / `SECQ_ANSWER_1..3` — a lowercase substring that
  identifies each of your security questions, and its answer. Check what's
  actually displayed on the ERP login page and match it exactly (e.g. if the
  page shows "What is your favourite Colour?", use `MATCH="Colour"`).
- `IMAP_EMAIL`, `IMAP_APP_PASSWORD` — the inbox that receives the ERP OTP
  mail. For Gmail: enable 2FA, then generate an
  [App Password](https://myaccount.google.com/apppasswords) — don't use your
  real account password.

**4. Load the extension into your browser:**

1. Open `brave://extensions` (or `chrome://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder.
4. Copy the **Extension ID** shown on the card — you need it next.

**5. Register the native messaging host**, passing the extension ID from step 4:

macOS/Linux:
```bash
./native-host/install.sh <extension-id>
```

This registers `native-host/run_native_host.sh` with Chrome/Brave so the
extension is allowed to launch it.

Windows (PowerShell):
```powershell
.\native-host\install.ps1 <extension-id>
```

This writes a filled-in copy of the host manifest and registers it under
`HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.erpautologin.helper`
(and the Brave equivalent), pointing at `native-host\run_native_host.bat`.

## Use it

Click the extension icon in your toolbar, then **"Log in to ERP"**. It opens
(or reuses) an ERP tab in your current window and logs in there.

## Troubleshooting

- **"Native host has exited"** — the project is probably inside a
  macOS-protected folder (see step 1), or the extension ID registered in
  step 5 doesn't match the one you loaded. Re-run `install.sh` with the
  correct ID and reload the extension.
- **Diagnostics log:** `~/Library/Application Support/erp-auto-login/host.log`
- **Nothing fills in / wrong security answer:** open DevTools on the ERP tab
  and check the console for `[erp]`-prefixed messages (add `console.log`
  calls back into `extension/content.js` temporarily if you need more detail
  — they were stripped for normal use since they can log the security
  question being answered).
- If ERP changes its form field IDs, the extension's selectors in
  `extension/content.js` will need updating — inspect the new page HTML and
  adjust `#user_id`, `#password`, `#question`, `#answer`, `#getotp`,
  `#email_otp1`, `#loginFormSubmitButton` accordingly.

`.env` is gitignored — never commit it. Each person who wants this needs
their own local `.env` and their own extension installation; nothing is
shared or hosted.
