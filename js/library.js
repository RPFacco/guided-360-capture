import { AuthError, GOOGLE_CLIENT_ID, api, apiUpload, clearToken, getToken, postJson, setToken } from "./api.js";

const $ = (id) => document.getElementById(id);
const libraryBtn = $("library-btn");
const loginForm = $("login-form"), emailInput = $("email"), passwordInput = $("password");
const registerBtn = $("register-btn"), loginBackBtn = $("login-back-btn"), loginError = $("login-error");
const googleBtn = $("google-btn");
const library = $("library"), libraryBackBtn = $("library-back-btn"), logoutBtn = $("logout-btn");
const zipInput = $("zip-input"), libraryMessage = $("library-message"), list = $("panorama-list");
const viewerBackBtn = $("viewer-back-btn"), viewerMessage = $("viewer-message"), downloadBtn = $("download-btn");
const previewBar = $("preview-bar"), previewSendBtn = $("preview-send-btn");
const viewerBackLabel = viewerBackBtn.textContent, previewSendLabel = previewSendBtn.textContent;

const POLL_MS = 5000;
const STATUS_LABELS = { pending: "Na fila", processing: "Costurando…", done: "Pronto", failed: "Falhou" };

let panoramas = [];
let pollTimer = null;
let viewer = null;
let viewerGen = 0;
let previewSend = null; // while the viewer shows the phone's own preview: sends that capture
// Not revoked when the viewer closes: Opera reads a download URL only once the user
// confirms its prompt. Same for the list's last download.
let image = null;
let listUrl = null;
let listBusy = false;
let pendingUpload = null;
let googleReady = false;

function show(id) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.classList.toggle("active", screen.id === id);
    screen.classList.toggle("hidden", screen.id !== id);
  }
  if (id === "login") renderGoogleButton();
  if (id !== "library") clearTimeout(pollTimer);
  if (id !== "viewer") closeViewer();
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
    showLoginError("Sua sessão expirou. Entre de novo.");
    show("login");
  } else {
    setMessage("Não foi possível conectar ao servidor.");
  }
}

export function stitchCapture(zip) {
  pendingUpload = zip;
  openLibrary();
}

function openLibrary() {
  if (!getToken()) {
    show("login");
    return;
  }
  setMessage("");
  show("library");
  if (!pendingUpload) {
    refresh();
    return;
  }
  const zip = pendingUpload;
  pendingUpload = null;
  upload(zip);
}

async function signIn() {
  showLoginError("");
  try {
    const res = await postJson("/api/login", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 401) return showLoginError("E-mail ou senha incorretos.");
    if (!res.ok) return showLoginError(`Falha ao entrar (${res.status}).`);
    setToken((await res.json()).token);
  } catch (_) {
    return showLoginError("Não foi possível conectar ao servidor.");
  }
  passwordInput.value = "";
  openLibrary();
}

function renderGoogleButton() {
  if (googleReady || !window.google?.accounts) return;
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: signInWithGoogle });
  google.accounts.id.renderButton(googleBtn, {
    theme: "outline",
    size: "large",
    locale: "pt-BR",
    width: Math.min(400, googleBtn.clientWidth),
  });
  googleReady = true;
}

async function signInWithGoogle({ credential }) {
  showLoginError("");
  try {
    const res = await postJson("/api/auth/google", { credential });
    if (res.status === 409) return showLoginError("Este e-mail já tem uma conta com senha. Entre com a senha.");
    if (!res.ok) return showLoginError(`Falha ao entrar com o Google (${res.status}).`);
    setToken((await res.json()).token);
  } catch (_) {
    return showLoginError("Não foi possível conectar ao servidor.");
  }
  openLibrary();
}

async function register() {
  showLoginError("");
  if (!loginForm.reportValidity()) return;
  try {
    const res = await postJson("/api/register", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 409) return showLoginError("Este e-mail já tem uma conta. Toque em Entrar.");
    if (res.status === 400) return showLoginError("Use um e-mail válido e uma senha com pelo menos 8 caracteres.");
    if (!res.ok) return showLoginError(`Não foi possível criar a conta (${res.status}).`);
  } catch (_) {
    return showLoginError("Não foi possível conectar ao servidor.");
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
    setMessage(`Não foi possível carregar seus panoramas (${res.status}).`);
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
    empty.textContent = "Nenhum panorama ainda. Envie o .zip de uma captura para costurar um.";
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
  date.textContent = new Date(panorama.created_at.replace(" ", "T") + "Z").toLocaleString("pt-BR");

  const info = document.createElement("div");
  info.className = "pano-info";
  info.append(title, date);

  const badge = document.createElement("span");
  badge.className = `badge ${panorama.status}`;
  badge.textContent = STATUS_LABELS[panorama.status] || panorama.status;

  const row = document.createElement("div");
  row.className = "pano-row";
  row.append(info, badge);

  const li = document.createElement("li");
  li.className = "pano-item";
  li.append(row);

  if (panorama.status === "done") {
    const view = document.createElement("button");
    view.className = "btn small";
    view.textContent = "Ver";
    view.addEventListener("click", () => openViewer(panorama.id));

    const download = document.createElement("button");
    download.className = "btn small";
    download.textContent = "Baixar";
    download.addEventListener("click", () => downloadPanorama(panorama.id, download));

    const actions = document.createElement("div");
    actions.className = "pano-actions";
    actions.append(view, download);
    li.append(actions);
  }
  return li;
}

const imageName = (id) => `panorama_${id}.jpg`;

function saveFile(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

// One at a time: the next download revokes this one's URL.
async function downloadPanorama(id, button) {
  if (listBusy) return;
  listBusy = true;
  button.textContent = "Baixando…";
  try {
    const res = await api(`/api/panoramas/${id}/image`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (listUrl) URL.revokeObjectURL(listUrl);
    listUrl = URL.createObjectURL(blob);
    saveFile(listUrl, imageName(id));
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setMessage("Não foi possível baixar o panorama.");
  } finally {
    listBusy = false;
    button.textContent = "Baixar";
  }
}

function setViewerMessage(text) {
  viewerMessage.textContent = text;
  viewerMessage.classList.toggle("hidden", !text);
}

async function openViewer(id) {
  const gen = ++viewerGen;
  setViewerMessage("Carregando…");
  show("viewer");
  if (image) URL.revokeObjectURL(image.url);
  image = null;
  try {
    const [res, { startViewer }] = await Promise.all([api(`/api/panoramas/${id}/image`), import("./viewer.js")]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (gen !== viewerGen) return;
    image = { url: URL.createObjectURL(blob), name: imageName(id) };
    downloadBtn.classList.remove("hidden");
    const started = await startViewer(image.url, setViewerMessage);
    if (gen !== viewerGen) return started.stop();
    viewer = started;
  } catch (err) {
    if (gen !== viewerGen) return;
    if (err instanceof AuthError) return handleError(err);
    setViewerMessage("Não foi possível abrir o panorama.");
  }
}

// The viewer pulls Three.js from unpkg. Warming the HTTP cache while the capture runs
// lets the phone's preview open even if the signal is gone by the time it is ready.
// A plain fetch, not import(): a failed import can stay failed for the whole page.
export function warmViewer() {
  const urls = ["js/viewer.js", "js/DeviceOrientationControls.js", "https://unpkg.com/three@0.132.0/build/three.module.js"];
  for (const url of urls) fetch(url).catch(() => {});
}

// The panorama the phone stitched by itself, before anything is sent: render(onProgress)
// resolves to its JPEG, send() packs the capture and hands it to stitchCapture.
export async function openPreview(render, send) {
  const gen = ++viewerGen;
  show("viewer");
  previewSend = send;
  viewerBackBtn.textContent = "← Início";
  setViewerMessage("Montando a prévia…");
  if (image) URL.revokeObjectURL(image.url);
  image = null;
  try {
    const progress = (done) => {
      if (gen === viewerGen) setViewerMessage(`Montando a prévia… ${Math.round(done * 100)}%`);
    };
    const [blob, { startViewer }] = await Promise.all([render(progress), import("./viewer.js")]);
    if (gen !== viewerGen) return;
    image = { url: URL.createObjectURL(blob), name: "panorama_previa.jpg" };
    downloadBtn.classList.remove("hidden");
    previewBar.classList.remove("hidden");
    const started = await startViewer(image.url, setViewerMessage);
    if (gen !== viewerGen) return started.stop();
    viewer = started;
  } catch (_) {
    if (gen !== viewerGen) return;
    previewBar.classList.remove("hidden");
    setViewerMessage("Não foi possível montar a prévia, mas dá para enviar para a versão final.");
  }
}

function closeViewer() {
  viewerGen++;
  viewer?.stop();
  viewer = null;
  downloadBtn.classList.add("hidden");
  previewSend = null;
  previewBar.classList.add("hidden");
  viewerBackBtn.textContent = viewerBackLabel;
}

zipInput.addEventListener("change", () => {
  const file = zipInput.files[0];
  zipInput.value = "";
  if (file) upload(file);
});

async function keepScreenOn() {
  try {
    return await navigator.wakeLock?.request("screen");
  } catch (_) {
    return null;
  }
}

async function upload(file) {
  const progress = (fraction) => setMessage(`Enviando… ${Math.round(fraction * 100)}%. Mantenha esta tela aberta.`);
  progress(0);
  const lock = await keepScreenOn();
  try {
    const status = await apiUpload(file, progress);
    if (status === 201) setMessage("Enviado. Já pode fechar o app: a versão final aparece aqui quando ficar pronta, o que pode demorar se tiver muita gente na fila.");
    else if (status === 400) setMessage("Esse arquivo não é um .zip de captura.");
    else if (status === 413) setMessage("O arquivo passa de 300 MB.");
    else setMessage(`Falha no envio (${status}).`);
  } catch (err) {
    handleError(err);
    return;
  } finally {
    lock?.release().catch(() => {});
  }
  refresh();
}

libraryBtn.addEventListener("click", openLibrary);
loginBackBtn.addEventListener("click", () => {
  pendingUpload = null;
  show("intro");
});
libraryBackBtn.addEventListener("click", () => show("intro"));
viewerBackBtn.addEventListener("click", () => (previewSend ? show("intro") : openLibrary()));
previewSendBtn.addEventListener("click", async () => {
  if (!previewSend || previewSendBtn.disabled) return;
  previewSendBtn.disabled = true;
  previewSendBtn.textContent = "Preparando…";
  try {
    await previewSend();
  } finally {
    previewSendBtn.disabled = false;
    previewSendBtn.textContent = previewSendLabel;
  }
});
downloadBtn.addEventListener("click", () => saveFile(image.url, image.name));
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
