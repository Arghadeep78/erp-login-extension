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
    // The background ignores a login click while one is already running, and
    // reports back which target is actually active — render() spins that button.
    refresh("login", btn.dataset.target);
  });
}

refresh("status");
setInterval(() => refresh("status"), 1000);
