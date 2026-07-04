// Drives the login form directly in this tab (the user's normal browser
// window — no separate automated browser is launched). Credentials, the
// security-question answer, and the OTP are fetched from the native host
// via short calls relayed through background.js; this script only touches
// the DOM. It reports the final outcome back with a separate message rather
// than holding one long-lived response channel open (which the service
// worker would let expire during the ~minute-long OTP wait).

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

// Poll `read` until it returns the same non-empty value continuously for
// `stableMs`, i.e. the page has stopped changing it. Guards against reading
// a value (like the random security question) while it's still settling.
function waitForStable(read, stableMs = 1000, timeout = 20000, interval = 150) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let last = "";
    let stableSince = 0;
    const tick = () => {
      const value = read();
      if (value && value === last) {
        if (Date.now() - stableSince >= stableMs) return resolve(value);
      } else {
        last = value;
        stableSince = Date.now();
      }
      if (Date.now() > deadline) {
        if (last) return resolve(last);
        return reject(new Error("Timed out waiting for stable value"));
      }
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
  // Fire the full range of events legacy page handlers may listen on. keydown/
  // keyup matter for pages that validate on keystroke; change/blur for those
  // that commit on focus loss (ERP validates the security answer on blur).
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

  // The page fetches a *random* security question and can re-roll it a moment
  // after it first appears. If we read too early and answer a stale question,
  // the server rejects it ("Unable to send OTP"). So: wait for the question
  // text to stay unchanged for a short window before treating it as final;
  // once stable it won't change again, so a single pass is enough.
  const question = await waitForStable(() => {
    const el = document.querySelector("#question");
    return el ? el.innerText.trim() : "";
  }, 600);

  const answerResp = await nativeCall("answer_security_question", { question });
  if (answerResp.status !== "success") {
    throw new Error(answerResp.message || `No stored answer for: ${question}`);
  }

  const answerEl = await waitFor(() => document.querySelector("#answer"));
  setValue(answerEl, answerResp.answer);
  answerEl.dispatchEvent(new Event("blur", { bubbles: true }));
  answerEl.blur();

  // Watermark the inbox right before requesting the OTP so fetchOtp only ever
  // considers mail that arrives after this point — a UID comparison, not a
  // timestamp one, so it can't be fooled by clock skew or accept a stale OTP
  // left over from an earlier attempt.
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
  // Do NOT report success here. Clicking submit POSTs the login and navigates
  // the tab, tearing down this content script mid-flight — reporting now is
  // premature and lets the background start its post-login navigation while
  // the tab is still on the SSO login domain (see run()'s caller). Success is
  // instead detected in background.js when the tab lands on /IIT_ERP3/.
}

// Guard against double-injection: only the first injection runs the flow.
if (!window.__erpAutoLoginStarted) {
  window.__erpAutoLoginStarted = true;
  // run() intentionally does not report success on resolve — the submit
  // navigation confirms login, and background.js watches for the tab landing
  // on /IIT_ERP3/ to settle success. We only report failures here.
  run().catch((err) => report("error", err.message));
}
