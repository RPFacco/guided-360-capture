import { AuthError, api, clearToken, getToken, postJson, setToken } from "./api.js";

const $ = (id) => document.getElementById(id);
const libraryBtn = $("library-btn");
const loginForm = $("login-form"), emailInput = $("email"), passwordInput = $("password");
const registerBtn = $("register-btn"), loginBackBtn = $("login-back-btn"), loginError = $("login-error");
const library = $("library"), libraryBackBtn = $("library-back-btn"), logoutBtn = $("logout-btn");
const zipInput = $("zip-input"), libraryMessage = $("library-message"), list = $("panorama-list");

const POLL_MS = 5000;
const STATUS_LABELS = { pending: "Waiting", processing: "Stitching…", done: "Ready", failed: "Failed" };

const preview = document.createElement("img");
preview.className = "pano-preview";
preview.alt = "Panorama";

let panoramas = [];
let previewId = null;
let previewUrl = null;
let pollTimer = null;

function show(id) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.classList.toggle("active", screen.id === id);
    screen.classList.toggle("hidden", screen.id !== id);
  }
  if (id !== "library") {
    clearTimeout(pollTimer);
    closePreview();
  }
}

function setMessage(text) {
  libraryMessage.textContent = text;
  libraryMessage.classList.toggle("hidden", !text);
}

function showLoginError(text) {
  loginError.textContent = text;
  loginError.classList.toggle("hidden", !text);
}

function handleError(err) {
  if (err instanceof AuthError) {
    showLoginError("Your session ended. Sign in again.");
    show("login");
  } else {
    setMessage("Could not reach the server.");
  }
}

function openLibrary() {
  if (!getToken()) {
    show("login");
    return;
  }
  setMessage("");
  show("library");
  refresh();
}

async function signIn() {
  showLoginError("");
  try {
    const res = await postJson("/api/login", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 401) return showLoginError("Wrong email or password.");
    if (!res.ok) return showLoginError(`Sign-in failed (${res.status}).`);
    setToken((await res.json()).token);
  } catch (_) {
    return showLoginError("Could not reach the server.");
  }
  passwordInput.value = "";
  openLibrary();
}

async function register() {
  showLoginError("");
  if (!loginForm.reportValidity()) return;
  try {
    const res = await postJson("/api/register", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 409) return showLoginError("This email already has an account. Sign in instead.");
    if (res.status === 400) return showLoginError("Use a valid email and a password with at least 8 characters.");
    if (!res.ok) return showLoginError(`Could not create the account (${res.status}).`);
  } catch (_) {
    return showLoginError("Could not reach the server.");
  }
  signIn();
}

async function refresh() {
  clearTimeout(pollTimer);
  let res;
  try {
    res = await api("/api/panoramas");
  } catch (err) {
    handleError(err);
    return;
  }
  if (!res.ok) {
    setMessage(`Could not load your panoramas (${res.status}).`);
    return;
  }
  panoramas = await res.json();
  if (!library.classList.contains("active")) return;

  draw();
  if (panoramas.some((p) => p.status === "pending" || p.status === "processing")) {
    pollTimer = setTimeout(refresh, POLL_MS);
  }
}

function draw() {
  if (!panoramas.length) {
    const empty = document.createElement("li");
    empty.className = "pano-empty";
    empty.textContent = "No panoramas yet. Upload the .zip from a capture to stitch one.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...panoramas.map(item));
}

function item(panorama) {
  const title = document.createElement("div");
  title.className = "pano-title";
  title.textContent = `Panorama #${panorama.id}`;

  // SQLite stores UTC; show it in the phone's own time zone.
  const date = document.createElement("div");
  date.className = "pano-date";
  date.textContent = new Date(panorama.created_at.replace(" ", "T") + "Z").toLocaleString();

  const info = document.createElement("div");
  info.className = "pano-info";
  info.append(title, date);

  const badge = document.createElement("span");
  badge.className = `badge ${panorama.status}`;
  badge.textContent = STATUS_LABELS[panorama.status] || panorama.status;

  const row = document.createElement("div");
  row.className = "pano-row";
  row.append(info, badge);

  if (panorama.status === "done") {
    const open = previewId === panorama.id;
    const button = document.createElement("button");
    button.className = "btn small";
    button.textContent = open ? (previewUrl ? "Hide" : "Loading…") : "View";
    button.addEventListener("click", () => togglePreview(panorama.id));
    row.append(button);
  }

  const li = document.createElement("li");
  li.className = "pano-item";
  li.append(row);
  if (previewId === panorama.id && previewUrl) li.append(preview);
  return li;
}

async function togglePreview(id) {
  const wasOpen = previewId === id;
  closePreview();
  if (wasOpen) {
    draw();
    return;
  }

  previewId = id;
  draw();
  try {
    const res = await api(`/api/panoramas/${id}/image`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (previewId !== id) return; // another one was opened meanwhile
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl;
  } catch (err) {
    if (previewId !== id) return;
    closePreview();
    if (err instanceof AuthError) {
      handleError(err);
      return;
    }
    setMessage("Could not load the image.");
  }
  draw();
}

function closePreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewId = null;
  preview.removeAttribute("src");
  preview.remove();
}

zipInput.addEventListener("change", async () => {
  const file = zipInput.files[0];
  zipInput.value = "";
  if (!file) return;

  setMessage("Uploading…");
  const body = new FormData();
  body.append("file", file);
  try {
    const res = await api("/api/panoramas", { method: "POST", body });
    if (res.status === 201) setMessage("Uploaded. Stitching takes about a minute.");
    else if (res.status === 400) setMessage("That file is not a capture .zip.");
    else if (res.status === 413) setMessage("The file is over 300 MB.");
    else setMessage(`Upload failed (${res.status}).`);
  } catch (err) {
    handleError(err);
    return;
  }
  refresh();
});

libraryBtn.addEventListener("click", openLibrary);
loginBackBtn.addEventListener("click", () => show("intro"));
libraryBackBtn.addEventListener("click", () => show("intro"));
registerBtn.addEventListener("click", register);
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  signIn();
});
logoutBtn.addEventListener("click", () => {
  clearToken();
  showLoginError("");
  show("login");
});
