// Thin UI over background.js, which owns the native host connection and
// drives the login form in a normal tab of this browser window. The popup
// can close at any time without killing the login; reopen it to see status.
const buttons = Array.from(document.querySelectorAll("button[data-target]"));
const status = document.getElementById("status");
const statusText = status.querySelector(".text");

// Show the version straight from the manifest so the footer never drifts out
// of sync with manifest.json on a version bump.
const footer = document.getElementById("footer");
if (footer) footer.textContent = `Secure · Local only · v${chrome.runtime.getManifest().version}`;

// The window the extension was clicked from, so background.js opens the ERP tab
// there. Use `lastFocusedWindow` (the normal browser window), NOT `currentWindow`
// — from a popup the latter can resolve to the popup's own window.
function getClickedWindowId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs[0]) return resolve(null);
      resolve(tabs[0].windowId);
    });
  });
}

function baseLabel(btn) {
  return btn.dataset.target === "cdc" ? "CDC" : "Academic";
}

function render(state) {
  const running = state.status === "running";
  // The background reports which target the in-flight login is for, so only
  // that button spins. No local guessing — this stays correct across popup
  // reopens and back-to-back clicks on different buttons.
  for (const btn of buttons) {
    const isActive = running && btn.dataset.target === state.target;
    // While a login runs, disable both buttons; only the active one spins.
    btn.disabled = running;
    btn.classList.toggle("running", isActive);
    // Keep the short name (Academic/CDC) even while running — the spinner
    // already signals progress, and a longer label would break the side-by-side
    // row. "You can close this popup." in the status line explains the wait.
    btn.querySelector(".label").textContent = baseLabel(btn);
  }

  status.classList.remove("success", "error");
  statusText.textContent = {
    idle: "Ready to sign in.",
    running: "You can close this popup.",
    // Surface the background's success message (e.g. "Already logged in.") so we
    // don't discard the distinction; fall back to a generic confirmation.
    success: state.message || "Logged in.",
    error: "Failed: " + (state.message || "something went wrong"),
  }[state.status];
  if (state.status === "success") status.classList.add("success");
  if (state.status === "error") status.classList.add("error");
}

// Poll the background for the current login state and reflect it in the UI.
function pollStatus() {
  chrome.runtime.sendMessage({ cmd: "status" }, (state) => {
    if (chrome.runtime.lastError) return;
    render(state);
  });
}

for (const btn of buttons) {
  btn.addEventListener("click", async () => {
    // Send the clicked window's id so background.js opens the ERP tab there. The
    // background ignores a login click while one is already running, and reports
    // back which target is active — render() spins that button.
    const windowId = await getClickedWindowId();
    const message = { cmd: "login", target: btn.dataset.target };
    if (windowId != null) message.windowId = windowId;
    chrome.runtime.sendMessage(message, (state) => {
      if (chrome.runtime.lastError) return;
      render(state);
    });
  });
}

pollStatus();
setInterval(pollStatus, 1000);
