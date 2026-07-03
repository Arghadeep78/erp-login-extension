// Owns the native messaging connection (credentials/security-answer/OTP
// lookups) and drives the login form in a normal tab of the user's current
// browser window via content.js — no separate automated browser window.
const HOST_NAME = "com.erpautologin.helper";
const LOGIN_URL =
  "https://erp.iitkgp.ac.in/SSOAdministration/login.htm?requestedUrl=https://erp.iitkgp.ac.in/IIT_ERP3/";

let state = { status: "idle", message: "" };
let nativePort = null;
let nextRequestId = 1;
const pendingNativeCalls = new Map();

function setState(status, message = "") {
  state = { status, message };
  const badge = { running: "...", success: "OK", error: "ERR" }[status] || "";
  chrome.action.setBadgeText({ text: badge });
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

// Navigate the tab to the login URL and resolve only once THAT navigation
// has finished loading. Waiting must be armed before issuing the navigation,
// otherwise chrome.tabs.get can report the previous page as already
// "complete" and we'd inject into a page about to be replaced.
function navigateAndWait(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Login page did not finish loading in time"));
    }, 30000);
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === "complete" && tab.url && tab.url.startsWith("https://erp.iitkgp.ac.in/")) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url: LOGIN_URL, active: true });
  });
}

async function getOrCreateLoginTab() {
  const [existing] = await chrome.tabs.query({ url: "https://erp.iitkgp.ac.in/*" });
  if (existing) return existing.id;
  const tab = await chrome.tabs.create({ url: "about:blank" });
  return tab.id;
}

async function runLogin() {
  // Open/focus the ERP login tab, navigate it, then inject content.js. The
  // content script self-runs and reports back via a "report_status" message —
  // we do NOT hold one long response channel open for the whole (~minute-long)
  // flow, since a service worker would let that channel expire mid-login.
  const tabId = await getOrCreateLoginTab();
  await navigateAndWait(tabId);
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
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "login") {
    if (state.status !== "running") {
      setState("running");
      runLogin().catch((err) => setState("error", err.message));
    }
    sendResponse(state);
    return;
  }

  if (msg.cmd === "report_status") {
    // Final outcome reported by content.js.
    setState(msg.status, msg.message || "");
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
