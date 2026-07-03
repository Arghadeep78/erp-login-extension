# IIT Kharagpur ERP Auto-Login

A browser extension for one-click login to the IIT Kharagpur ERP system. It automatically fills your ID/password, answers the security question, fetches the email OTP, and submits the form securely within your browser tab.

## Architecture

- `extension/`: Browser extension scripts to drive the login form.
- `native-host/`: A Python helper that securely provides credentials, security answers, and IMAP OTPs via Chrome Native Messaging.

*Note: All secrets remain strictly local in your `.env` file.*

## Setup

**1. Clone carefully:** Do not place this project in `~/Desktop`, `~/Documents`, or `~/Downloads` on macOS, as it blocks execution. *(Windows users can clone it anywhere).*

**2. Install dependencies:**

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

**3. Configure credentials:**
macOS/Linux:
```bash
cp .env.example .env
```

Windows (Command Prompt):
```cmd
copy .env.example .env
```
Edit `.env` with your ERP login, security questions, and an IMAP App Password.
*(Note: Use quotes `""` for values with spaces/special characters. For Gmail, 2FA must be enabled to generate an [App Password](https://myaccount.google.com/apppasswords)).*

**4. Load extension:**
1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Copy the generated **Extension ID**.

**5. Register native host:**

macOS/Linux:
```bash
./native-host/install.sh <extension-id>
```

Windows (PowerShell):
```powershell
.\native-host\install.ps1 <extension-id>
```

## Usage

Click the extension icon in your toolbar and select **"Log in to ERP"**.

## Troubleshooting

- **"Native host has exited"**: Ensure the project is not in a macOS-protected folder and that the Extension ID matches.
- **Log file**: 
  - macOS/Linux: `~/Library/Application Support/erp-auto-login/host.log`
  - Windows: `%LOCALAPPDATA%\erp-auto-login\host.log`
- **Selectors**: If the ERP login page changes, update the HTML element selectors in `extension/content.js`.
- **General issues / stale credentials**: Go to `chrome://extensions` (or `brave://extensions`) and click the refresh icon on the extension card after editing `.env` or if it becomes unresponsive.
