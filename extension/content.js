// Drives the login form in this tab. Credentials, the security answer, and the
// OTP come from the native host via short calls relayed through background.js;
// this script only touches the DOM. Failures are reported back via a separate
// message rather than one long-lived channel (which would expire mid-login).

function waitFor(check, timeout = 20000, interval = 200) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error("Timed out waiting for page state"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

function setValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  el.focus();
  setter.call(el, value);
  // Fire the full range of events the legacy page may validate on (it checks
  // the security answer on blur, others on keystroke).
  for (const type of ["keydown", "keypress", "input", "keyup", "change"]) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}


function nativeCall(action, params = {}) {
  return chrome.runtime.sendMessage({ cmd: "native", action, ...params });
}

function report(status, message = "") {
  chrome.runtime.sendMessage({ cmd: "report_status", status, message });
}

async function fetchOtp(minUid) {
  // Poll: each native call blocks at most ~10s, then we retry until the
  // mail arrives or we give up. Keeps every message channel short-lived.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const resp = await nativeCall("fetch_otp", { min_uid: minUid });
    if (resp.status === "success") return resp.otp;
    if (resp.status === "error") throw new Error(resp.message || "OTP fetch failed");
    // status === "pending": loop and try again
  }
  throw new Error("OTP email not received within timeout");
}

// The blocking window.alert("OTP sent...") the page pops after getotp is
// neutralized by background.js, which injects an alert override into the
// page's MAIN world before this script runs (see runLogin there).
async function run() {
  const creds = await nativeCall("get_credentials");
  if (!creds || creds.status !== "success") {
    throw new Error((creds && creds.message) || "Failed to get credentials (is the native host installed?)");
  }

  const userIdEl = await waitFor(() => document.querySelector("#user_id"));
  const passwordEl = await waitFor(() => document.querySelector("#password"));
  setValue(userIdEl, creds.user_id);
  setValue(passwordEl, creds.password);
  // Filling #password then blurring #user_id is what triggers the page to
  // fetch the (random) security question.
  userIdEl.dispatchEvent(new Event("blur", { bubbles: true }));
  passwordEl.focus();

  // The page picks a *random* security question and can re-roll it just after
  // it first appears; answering a stale one makes the server reject with
  // "Unable to send OTP". Let it appear, give it a beat to settle, then read.
  const readQuestion = () => {
    const el = document.querySelector("#question");
    return el ? el.innerText.trim() : "";
  };
  await waitFor(readQuestion);
  await new Promise((r) => setTimeout(r, 600));
  const question = readQuestion();
  if (!question) throw new Error("Security question did not appear");

  const answerResp = await nativeCall("answer_security_question", { question });
  if (answerResp.status !== "success") {
    throw new Error(answerResp.message || `No stored answer for: ${question}`);
  }

  const answerEl = await waitFor(() => document.querySelector("#answer"));
  setValue(answerEl, answerResp.answer);
  answerEl.blur();

  // Watermark the inbox (by UID, not timestamp — no clock-skew issues) right
  // before requesting the OTP, so fetchOtp ignores any stale OTP from an earlier
  // attempt and only reads mail arriving after this point.
  const watermark = await nativeCall("mark_otp_watermark");
  if (!watermark || watermark.status !== "success") {
    throw new Error((watermark && watermark.message) || "Failed to watermark inbox before OTP request");
  }

  const getOtpBtn = await waitFor(() => document.querySelector("#getotp"));
  getOtpBtn.click();

  await waitFor(() => {
    const el = document.querySelector("#loginFormSubmitButton");
    return el && el.offsetParent !== null ? el : null;
  }, 20000);

  const otp = await fetchOtp(watermark.min_uid);

  const otpEl = await waitFor(() => document.querySelector("#email_otp1"));
  setValue(otpEl, otp);

  const submitBtn = await waitFor(() => document.querySelector("#loginFormSubmitButton"));
  submitBtn.click();
  // No success report: the submit navigates away and tears this script down.
  // background.js settles success when the tab lands on /IIT_ERP3/.
}

// Guard against double-injection: only the first injection runs the flow.
if (!window.__erpAutoLoginStarted) {
  window.__erpAutoLoginStarted = true;
  run().catch((err) => report("error", err.message));
}
