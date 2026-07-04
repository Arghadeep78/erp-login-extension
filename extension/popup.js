// Thin UI over background.js, which owns the native host connection and
// drives the login form in a normal tab of this browser window. The popup
// can close at any time without killing the login; reopen it to see status.
const buttons = Array.from(document.querySelectorAll("button[data-target]"));
const status = document.getElementById("status");
const statusText = status.querySelector(".text");

// Which target the in-flight login is for, so only that button spins. Persisted
// across popup reopens via session storage — the background service worker only
// tracks status, not which button started it.
let activeTarget = null;

// The browser window this popup was opened from. Passed along with the login
// command so background.js opens the ERP tab in *this* window rather than
// guessing (Brave otherwise sometimes spawns a stray mini window). We anchor on
// the active tab's windowId — chrome.windows.getCurrent() can instead return
// the popup's own popup-type window, which is what caused the stray window.
let popupWindowId = null;
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!chrome.runtime.lastError && tabs && tabs[0]) popupWindowId = tabs[0].windowId;
});

function baseLabel(btn) {
  return btn.dataset.target === "cdc" ? "Log in to CDC" : "Log in to Academic";
}

function render(state) {
  const running = state.status === "running";
  // Once no login is running, forget the active target so the next click can
  // claim its own button (see the click handler's activeTarget === null guard).
  if (!running) activeTarget = null;
  for (const btn of buttons) {
    const isActive = running && btn.dataset.target === activeTarget;
    // While a login runs, disable both buttons; only the active one spins.
    btn.disabled = running;
    btn.classList.toggle("running", isActive);
    btn.querySelector(".label").textContent = isActive ? "Logging in..." : baseLabel(btn);
  }

  status.classList.remove("success", "error");
  statusText.textContent = {
    idle: "",
    running: "You can close this popup.",
    success: "Logged in.",
    error: "Failed: " + state.message,
  }[state.status];
  if (state.status === "success") status.classList.add("success");
  if (state.status === "error") status.classList.add("error");
}

function refresh(cmd, target, onState) {
  const message = { cmd };
  if (target) message.target = target;
  if (cmd === "login" && popupWindowId != null) message.windowId = popupWindowId;
  chrome.runtime.sendMessage(message, (state) => {
    if (chrome.runtime.lastError) return;
    if (onState) onState(state);
    render(state);
  });
}

for (const btn of buttons) {
  btn.addEventListener("click", () => {
    // The background ignores a login click while one is already running. Only
    // claim this button as active if it wasn't already running before we asked
    // — otherwise we'd spin the wrong button over the actually-running login.
    refresh("login", btn.dataset.target, (state) => {
      if (state.status === "running" && activeTarget === null) {
        activeTarget = btn.dataset.target;
        chrome.storage.session.set({ activeTarget });
      }
    });
  });
}

// Restore which button is active (if a login is still running from before the
// popup was reopened) before the first status render.
chrome.storage.session.get("activeTarget", (data) => {
  activeTarget = data.activeTarget || null;
  refresh("status");
});
setInterval(() => refresh("status"), 1000);
