// Thin UI over background.js, which owns the native host connection and
// drives the login form in a normal tab of this browser window. The popup
// can close at any time without killing the login; reopen it to see status.
const button = document.getElementById("login-btn");
const label = button.querySelector(".label");
const status = document.getElementById("status");
const statusText = status.querySelector(".text");

function render(state) {
  const running = state.status === "running";
  button.disabled = running;
  button.classList.toggle("running", running);
  label.textContent = running ? "Logging in..." : "Log in to ERP";

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

function refresh(cmd) {
  chrome.runtime.sendMessage({ cmd }, (state) => {
    if (!chrome.runtime.lastError) render(state);
  });
}

button.addEventListener("click", () => refresh("login"));
refresh("status");
setInterval(() => refresh("status"), 1000);
