// Owns the native messaging connection (credentials/security-answer/OTP
// lookups) and drives the login form in a normal tab of the user's current
// browser window via content.js — no separate automated browser window.
const HOST_NAME = "com.erpautologin.helper";
const DASHBOARD_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/";
const LOGIN_URL =
  "https://erp.iitkgp.ac.in/SSOAdministration/login.htm?requestedUrl=https://erp.iitkgp.ac.in/IIT_ERP3/";
// Academic module landing page (module_id=16), opened after a successful login
// via the default "Log in to ERP" button instead of the plain home page.
const ACADEMIC_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/menulist.htm?module_id=16";
// CDC module landing page (module_id=26), opened after a successful login when
// the user picks "Log in to CDC".
const CDC_URL = "https://erp.iitkgp.ac.in/IIT_ERP3/menulist.htm?module_id=26";
// The CDC > Student > "Application of Placement/Internship" menu item. On the
// CDC page this link calls showMenu(...) which (for an active, non-delegated
// menu) POSTs these exact fields to showmenu.htm. We submit that form directly
// instead of waiting for the async-rendered accordion and clicking it.
const CDC_PLACEMENT_MENU = {
  module_id: "26",
  menu_id: "11",
  link: "https://erp.iitkgp.ac.in/TrainingPlacementSSO/TPStudent.jsp",
  module_name: "CDC",
  parent_display_name: "Student",
  display_name: "Application of Placement/Internship",
};

let state = { status: "idle", message: "" };
// While a login is in flight, holds the waitForLoggedIn reject handle so a
// content.js error report can abort the wait. Cleared once login settles.
let pendingNav = null; // { tabId, reject } | null
let nativePort = null;
let nextRequestId = 1;
const pendingNativeCalls = new Map();

function setState(status, message = "") {
  state = { status, message };
  const badge = { running: "...", error: "ERR" }[status] || "";
  chrome.action.setBadgeText({ text: badge });
  if (status === "success") {
    chrome.action.setBadgeText({ text: "OK" });
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

// Navigate the tab to `url` and resolve with the tab's final URL once that
// navigation has finished loading (following any server-side redirect).
// Waiting must be armed before issuing the navigation, otherwise
// chrome.tabs.get can report the previous page as already "complete" and
// we'd read/inject into a page about to be replaced.
// If `url` is omitted, no navigation is issued — the caller triggers it another
// way (e.g. an injected form submit) and we just wait for the next load.
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
    if (url) chrome.tabs.update(tabId, { url, active: true });
  });
}

// After landing on the CDC menu page, submit the showmenu.htm form for the
// Placement/Internship menu in the page's MAIN world, then wait for the
// resulting navigation to finish. Mirrors what the page's own showMenu ->
// forwardToShowmenu does on click, so it doesn't depend on the async accordion.
async function openCdcPlacementMenu(tabId) {
  // Arm the load wait BEFORE submitting so we don't miss the navigation.
  const done = navigateAndWait(tabId);
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

// Resolve once the tab lands on the post-login dashboard (/IIT_ERP3/, off the
// SSO login domain), i.e. the login POST content.js submitted has succeeded.
// Rejects if content.js reports an error first (via pendingNav.reject) or the
// login doesn't complete within the timeout. This is how we know login is done
// WITHOUT racing the in-flight submit — we never navigate the tab until the
// server has taken it to the dashboard on its own.
function waitForLoggedIn(tabId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      pendingNav = null;
      reject(new Error("Login did not complete within timeout"));
    }, timeoutMs);
    const listener = (updatedTabId, info, tab) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      // Match on the path, not the whole href: the login URL carries
      // "IIT_ERP3" in its requestedUrl query param, so a substring test would
      // false-positive on the login page itself.
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

async function getOrCreateLoginTab(preferredWindowId) {
  const [existing] = await chrome.tabs.query({ url: "https://erp.iitkgp.ac.in/*" });
  if (existing) {
    // Focus the window that already hosts the ERP tab so it doesn't stay
    // buried behind others.
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing.id;
  }
  // Create the tab in the window the popup was opened from, so it lands in the
  // window the user is actually looking at (Brave otherwise sometimes spawns or
  // targets a stray window). Fall back to the last-focused normal window if the
  // caller didn't supply one (or it's since been closed).
  let windowId = preferredWindowId;
  if (windowId != null) {
    try {
      // Verify it still exists AND is a normal browser window — never target a
      // popup/app-type window, which is what produced the stray mini window.
      const win = await chrome.windows.get(windowId);
      if (win.type !== "normal") windowId = undefined;
    } catch (_) {
      windowId = undefined;
    }
  }
  if (windowId == null) {
    // No usable window from the caller — pick the most recently focused normal
    // browser window ourselves rather than letting tabs.create default (which
    // could still land in a popup-type window).
    try {
      const lastFocused = await chrome.windows.getLastFocused();
      if (lastFocused.type === "normal") {
        windowId = lastFocused.id;
      } else {
        const normals = (await chrome.windows.getAll({ windowTypes: ["normal"] }))
          .filter((w) => w.type === "normal");
        windowId = (normals[0] || {}).id;
      }
    } catch (_) {
      windowId = undefined;
    }
  }
  if (windowId == null) {
    // Genuinely no normal window open: create one explicitly.
    const win = await chrome.windows.create({ url: "about:blank" });
    return win.tabs[0].id;
  }
  const tab = await chrome.tabs.create({ url: "about:blank", windowId });
  return tab.id;
}

async function runLogin(target = "erp", preferredWindowId) {
  // Open/focus the ERP login tab, navigate it, then inject content.js. The
  // content script self-runs and reports back via a "report_status" message —
  // we do NOT hold one long response channel open for the whole (~minute-long)
  // flow, since a service worker would let that channel expire mid-login.
  const tabId = await getOrCreateLoginTab(preferredWindowId);

  // Probe the dashboard URL first: a live session stays there, while a logged-
  // out request gets bounced to the SSO login page by the server. Hitting the
  // explicit SSOAdministration/login.htm URL directly (as done below when we
  // do need to log in) always renders the login form regardless of session
  // state, so it can't be used for this check. An idle/expired session is
  // instead bounced to logoutmsg.htm (a notice page, not the login form), so
  // that must also be treated as logged-out rather than "already logged in".
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
  // getotp. This must run in the page's MAIN world (not the content-script
  // isolated world) to override the page's own alert, and injecting via
  // executeScript bypasses the page CSP that blocks an inline <script>.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      window.alert = () => {};
      window.confirm = () => true;
    },
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  // content.js fills the form and clicks submit, but does NOT report success —
  // its submit navigates the tab and tears the script down. We instead wait for
  // the server to land the tab on the dashboard, which confirms login is truly
  // complete, and only THEN drive the post-login navigation. This ordering is
  // what fixes the races: navigating for the landing page / CDC menu while the
  // login POST was still in flight caused the showmenu.htm 404 (relative action
  // resolved against /SSOAdministration/) and aborted OTP entry.
  await waitForLoggedIn(tabId);
  await goToLandingPage(tabId, target);
  setState("success", "");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "login") {
    if (state.status !== "running") {
      setState("running");
      runLogin(msg.target || "erp", msg.windowId).catch((err) => setState("error", err.message));
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
