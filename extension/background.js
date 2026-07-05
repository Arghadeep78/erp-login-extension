// Owns the native messaging connection (credentials/security-answer/OTP
// lookups) and drives the login form in a normal tab of the user's current
// browser window via content.js — no separate automated browser window.
const HOST_NAME = "com.erpautologin.helper";
const DASHBOARD_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/";
const LOGIN_URL =
  "https://erp.iitkgp.ac.in/SSOAdministration/login.htm?requestedUrl=https://erp.iitkgp.ac.in/IIT_ERP3/";
// Post-login landing pages: Academic (module 16) for the default button, CDC
// (module 26) for the CDC button.
const ACADEMIC_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/menulist.htm?module_id=16";
const CDC_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/menulist.htm?module_id=26";
// The CDC > Student > "Application of Placement/Internship" menu item. The
// page's showMenu(...) POSTs these exact fields to showmenu.htm; we POST them
// directly (see openCdcPlacementMenu) rather than waiting on the async accordion.
const CDC_PLACEMENT_MENU = {
  module_id: "26",
  menu_id: "11",
  link: "https://erp.iitkgp.ac.in/TrainingPlacementSSO/TPStudent.jsp",
  module_name: "CDC",
  parent_display_name: "Student",
  display_name: "Application of Placement/Internship",
};

let state = { status: "idle", message: "", target: null };
// The tab the current login is running in, or null when idle. Used to detect
// the user closing that tab/window mid-login (see chrome.tabs.onRemoved below).
let activeLoginTabId = null;
// While a login is in flight, holds the waitForLoggedIn reject handle so a
// content.js error report can abort the wait. Cleared once login settles.
let pendingNav = null; // { tabId, reject } | null
let nativePort = null;
let nextRequestId = 1;
const pendingNativeCalls = new Map();

function setState(status, message = "", target = state.target) {
  state = { status, message, target };
  // Keep tracking the login tab through "success" too (so closing it still
  // clears the "OK" badge); only drop the reference once we're fully idle/errored.
  if (status === "idle" || status === "error") activeLoginTabId = null;
  chrome.action.setBadgeText({ text: { running: "...", success: "OK", error: "ERR" }[status] || "" });
  if (status === "success") {
    // Revert to idle after 10s so the popup's "Logged in." text and the
    // toolbar badge don't linger indefinitely.
    setTimeout(() => {
      if (state.status === "success") {
        state = { status: "idle", message: "" };
        chrome.action.setBadgeText({ text: "" });
      }
    }, 10000);
  }
}

function getNativePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener((response) => {
    const { requestId, ...rest } = response;
    const pending = pendingNativeCalls.get(requestId);
    if (pending) {
      pendingNativeCalls.delete(requestId);
      pending.resolve(rest);
    }
  });
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "native host disconnected";
    for (const { reject } of pendingNativeCalls.values()) reject(new Error(err));
    pendingNativeCalls.clear();
    nativePort = null;
  });
  return nativePort;
}

function callNative(action, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    pendingNativeCalls.set(requestId, { resolve, reject });
    getNativePort().postMessage({ action, requestId, ...params });
  });
}

// Navigate the tab to `url` and resolve with its final URL once loading
// finishes (following any redirect). The listener is armed before navigating so
// we can't miss the load. If `url` is omitted, no navigation is issued — the
// caller triggers it another way (e.g. an injected form submit) and we just
// wait for the next load.
function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Page did not finish loading in time"));
    }, 30000);
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === "complete" && tab.url && tab.url.startsWith("https://erp.iitkgp.ac.in/")) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Navigate in place WITHOUT activating — the login tab is activated once
    // when it's first opened; forcing it active on every internal navigation
    // would yank the user back if they switched tabs mid-login.
    if (url) chrome.tabs.update(tabId, { url });
  });
}

// Submit the showmenu.htm form for the Placement/Internship menu directly,
// mirroring the page's own showMenu -> forwardToShowmenu so we don't depend on
// the async-rendered accordion.
async function openCdcPlacementMenu(tabId) {
  const done = navigateAndWait(tabId); // arm before submitting
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (fields) => {
      const f = document.createElement("form");
      f.method = "post";
      // Absolute action: a relative "showmenu.htm" resolves against whatever
      // path the tab is on, which 404s if we're not under /IIT_ERP3/.
      f.action = "https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm";
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        f.appendChild(input);
      }
      document.body.appendChild(f);
      f.submit();
    },
    args: [CDC_PLACEMENT_MENU],
  });
  await done;
}

// Once logged in, take the tab to the target's landing destination:
//   "erp" -> Academic module page (instead of the plain home page)
//   "cdc" -> CDC module page, then the Placement/Internship menu
async function goToLandingPage(tabId, target) {
  if (target === "cdc") {
    await navigateAndWait(tabId, CDC_URL);
    await openCdcPlacementMenu(tabId);
  } else {
    await navigateAndWait(tabId, ACADEMIC_URL);
  }
}

// Resolve once the tab lands on /IIT_ERP3/ (off the SSO login domain), i.e. the
// login POST succeeded. Rejects on a content.js error (via pendingNav.reject)
// or timeout.
function waitForLoggedIn(tabId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      pendingNav = null;
      reject(new Error("Login did not complete within timeout"));
    }, timeoutMs);
    const listener = (updatedTabId, info, tab) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      // Match on the path, not the href: the login URL carries "IIT_ERP3" in its
      // requestedUrl query param, so a substring test would false-positive on it.
      let path = "";
      try {
        path = new URL(tab.url || "").pathname;
      } catch {
        return;
      }
      if (path.startsWith("/IIT_ERP3/")) {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    // Let a content.js error abort the wait.
    pendingNav = {
      tabId,
      reject: (err) => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        reject(err);
      },
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Reuse an existing ERP tab in the clicked window, or open one there. Scoped to
// the one window (windowId, from the popup) so we never touch other windows and
// never create a browser window.
async function getOrCreateLoginTab(windowId) {
  const [existing] = await chrome.tabs.query({
    url: "https://erp.iitkgp.ac.in/*",
    windowId,
  });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: "about:blank", windowId, active: true });
  return tab.id;
}

async function runLogin(target = "erp", preferredWindowId) {
  // content.js is injected below and reports back via a separate "report_status"
  // message — we don't hold one response channel open for the ~minute-long flow,
  // which the service worker would let expire mid-login.
  const tabId = await getOrCreateLoginTab(preferredWindowId);
  activeLoginTabId = tabId;

  // Probe the dashboard: a live session stays there; a logged-out one is bounced
  // to the SSO login page (or, if idle/expired, to logoutmsg.htm) — both mean we
  // must log in. (The login.htm URL always renders the form regardless of
  // session state, so it can't be used for this check.)
  const probeUrl = await navigateAndWait(tabId, DASHBOARD_URL);
  if (!probeUrl.includes("/SSOAdministration/login") && !probeUrl.includes("/SSOAdministration/logoutmsg")) {
    // Already logged in: go straight to the target's landing page.
    await goToLandingPage(tabId, target);
    setState("success", "Already logged in.");
    return;
  }

  await navigateAndWait(tabId, LOGIN_URL);
  // Warm the native port up front so a connection failure surfaces immediately
  // rather than only when content.js makes its first call.
  getNativePort();
  // Neutralize the blocking window.alert("OTP sent...") the page pops after
  // getotp. Must run in the page's MAIN world to override the page's own alert;
  // executeScript injection bypasses the CSP that blocks an inline <script>.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      window.alert = () => {};
    },
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  // content.js submits the login but does NOT report success (its submit tears
  // the script down). Wait for the server to land the tab on the dashboard
  // before driving post-login navigation — navigating earlier races the
  // in-flight POST.
  await waitForLoggedIn(tabId);
  await goToLandingPage(tabId, target);
  setState("success", "");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "login") {
    if (state.status !== "running") {
      const target = msg.target || "erp";
      setState("running", "", target);
      runLogin(target, msg.windowId).catch((err) => setState("error", err.message));
    }
    sendResponse(state);
    return;
  }

  if (msg.cmd === "report_status") {
    // content.js only reports failures now (success is detected by
    // waitForLoggedIn watching the tab reach the dashboard). Abort the
    // in-flight login wait, if any, and settle the error.
    if (msg.status !== "success") {
      if (pendingNav && pendingNav.reject) pendingNav.reject(new Error(msg.message || "Login failed"));
      pendingNav = null;
      setState(msg.status, msg.message || "");
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.cmd === "native") {
    // Relay a native-host call issued by content.js in the login tab.
    const { cmd, action, ...params } = msg;
    callNative(action, params)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ status: "error", message: err.message }));
    return true; // async response
  }

  sendResponse(state);
});

// Closing the login tab (or its window) tears down the flow: abort any pending
// wait, then reset to a clean idle state with a blank toolbar badge so no stale
// "..."/"OK"/"ERR" indicator lingers — whether the login was still running or
// had just finished.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeLoginTabId) return;
  if (pendingNav && pendingNav.reject) pendingNav.reject(new Error("Login tab was closed"));
  pendingNav = null;
  activeLoginTabId = null;
  state = { status: "idle", message: "", target: null };
  chrome.action.setBadgeText({ text: "" });
});
