import {
  TOTAL_SHOTS, LEVEL_TARGETS, LEVEL_SHOTS, photos, headingLost, isDone, resetSession, restoreSession,
  anchorHeading, loseHeading, recalibrate, shotFailed, shotTaken, undoShot,
} from "./session.js";
import {
  gyroActive, gotOrientation, rawPitch, rawYaw, displayPitch, displayYaw,
  requestGyro, startOrientation, stopOrientation, smoothOrientation, forgetHeading,
  captureRotation,
} from "./orientation.js";
import { hasVFC, onFrame, startCamera, stopCamera, capturePhoto, resumePreview, probeStillFov, shotFov } from "./camera.js";
import { updateTilt, updateHUD, updatePerf, countFrame, showShot, setPrompt } from "./hud.js";
import { initDome, drawDome } from "./dome.js";
import { initTargets, drawTargets } from "./targets.js";
import { holdProgress, updateAutoShot } from "./autoshot.js";
import { openStorage, savePhoto, deletePhoto, clearStorage, readPhoto, readMeta, photoKey } from "./storage.js";
import { buildZip } from "./zip.js";
import { stitchCapture } from "./library.js";
import { startVoice, stopVoice, resumeVoice, repeatVoice, toggleVoice, voiceMuted } from "./voice.js";

const $ = (id) => document.getElementById(id);
const intro = $("intro"), capture = $("capture");
const startBtn = $("start-btn"), restartBtn = $("restart-btn"), errorEl = $("error");
const undoBtn = $("undo-btn"), exportBtn = $("export-btn"), stitchBtn = $("stitch-btn");
const repeatBtn = $("repeat-btn"), voiceBtn = $("voice-btn");
const volumeDialog = $("volume-dialog"), volumeOk = $("volume-ok");
const flash = $("flash");
const exportLabel = exportBtn.textContent;

let running = false;
let busy = false;
let storedCount = 0; // photos an earlier page left behind, from shot 1 with no gaps
let restartArmed = false;
let wakeLock = null;
let pendingResume = false; // the start waiting on the volume notice

const dbReady = openStorage().then((n) => {
  storedCount = n;
  if (storedCount) {
    startBtn.textContent = `Continuar (${storedCount} de ${TOTAL_SHOTS})`;
    restartBtn.classList.remove("hidden");
  }
});

// The notice's own button starts the capture, so iOS still gets a tap for the
// gyroscope and the audio.
function askVolume(resume) {
  if (voiceMuted()) return begin(resume);
  pendingResume = resume;
  volumeDialog.showModal();
}

volumeOk.addEventListener("click", () => {
  volumeDialog.close();
  begin(pendingResume);
});

startBtn.addEventListener("click", () => askVolume(true));

// Two taps rather than confirm(): a modal between the tap and requestPermission could
// cost iOS the user gesture it insists on.
restartBtn.addEventListener("click", () => {
  if (!restartArmed) {
    restartArmed = true;
    restartBtn.textContent = `Toque de novo para descartar ${storedCount} fotos`;
    return;
  }
  askVolume(false);
});

async function begin(resume) {
  errorEl.classList.add("hidden");
  startBtn.disabled = restartBtn.disabled = true;

  // Before anything else is awaited: iOS only grants orientation and audio from inside the tap.
  const gyro = requestGyro();
  startVoice(!(resume && storedCount));
  await gyro;

  await dbReady;
  resetSession();
  if (resume && storedCount) {
    restoreSession(storedCount);
    for (const p of photos) {
      const m = await readMeta(p);
      if (m) { p.rotation = m.rotation; p.fov = m.fov; p.target = m.target; }
    }
  } else {
    await clearStorage();
    storedCount = 0;
  }

  try {
    await startCamera();
  } catch (err) {
    errorEl.textContent = "Erro na câmera: " + err.message + " (precisa de uma página HTTPS)";
    errorEl.classList.remove("hidden");
    startBtn.disabled = restartBtn.disabled = false;
    stopVoice();
    return;
  }

  if (gyroActive) {
    startOrientation();
    setTimeout(() => { if (!gotOrientation) noSensor(); }, 2000);
  } else {
    noSensor();
  }

  intro.classList.replace("active", "hidden");
  capture.classList.replace("hidden", "active");

  running = true;
  keepAwake();
  initDome();
  initTargets();
  updateHUD();
  updatePerf();
  probeStillFov();
  requestAnimationFrame(renderLoop);
}

function noSensor() {
  stopOrientation();
  updateHUD();
}

// The browser drops the lock when the page is hidden.
function keepAwake() {
  if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((lock) => { wakeLock = lock; }, () => {});
}

function leaveCapture() {
  running = false;
  stopOrientation();
  stopCamera();
  stopVoice();
  wakeLock?.release().catch(() => {});
  wakeLock = null;

  storedCount = photos.length;
  startBtn.textContent = `Continuar (${storedCount} de ${TOTAL_SHOTS})`;
  restartArmed = false;
  restartBtn.textContent = "Recomeçar";
  restartBtn.classList.remove("hidden");
  startBtn.disabled = restartBtn.disabled = false;
}

document.addEventListener("visibilitychange", () => {
  if (!running) return;
  if (document.hidden) {
    // Relative yaw may restart while hidden, same as a reload.
    loseHeading(busy);
    forgetHeading();
    stopVoice();
    updateHUD();
    return;
  }
  resumePreview();
  keepAwake();
  resumeVoice();
});

function showVoice() {
  voiceBtn.classList.toggle("off", voiceMuted());
  voiceBtn.setAttribute("aria-label", voiceMuted() ? "Ligar voz" : "Desligar voz");
}
showVoice();

voiceBtn.addEventListener("click", () => {
  toggleVoice();
  showVoice();
});
repeatBtn.addEventListener("click", () => repeatVoice(!photos.length));

window.addEventListener("resize", () => { if (running) initTargets(); });

onFrame(() => drawTargets(holdProgress));

function renderLoop(now) {
  if (!running) return;
  smoothOrientation();
  if (gyroActive && rawPitch !== null) updateTilt(displayPitch);
  if (gyroActive && rawYaw !== null) anchorHeading(displayYaw);
  if (updateAutoShot(now, busy)) shoot();
  drawDome();
  if (!hasVFC) drawTargets(holdProgress);
  countFrame(now);
  requestAnimationFrame(renderLoop);
}

undoBtn.addEventListener("click", () => {
  if (busy) return;

  // Recalibration: aimed back at the last photo, so no photo is taken.
  if (headingLost() && gyroActive && rawYaw !== null) {
    recalibrate(rawYaw);
    updateHUD();
    return;
  }
  if (!photos.length) return;
  if (isDone()) {
    exportBtn.disabled = false;
    exportBtn.textContent = exportLabel;
  }
  deletePhoto(undoShot());
  updateHUD();
});

async function shoot() {
  busy = true;
  const rotation = captureRotation(); // the capture can take a second, and the phone moves on

  flash.classList.add("animate");
  setTimeout(() => flash.classList.remove("animate"), 180);

  undoBtn.disabled = true;
  let blob = null;
  try {
    blob = await capturePhoto();
  } catch (_) {}
  undoBtn.disabled = !photos.length;
  busy = false;

  if (!blob) {
    shotFailed();
    setPrompt("A foto falhou - segure parado para tentar de novo.", "falhou");
    return;
  }

  // Size from the blob directly - no createImageBitmap (that bitmap leaked memory on iOS).
  showShot(blob.size);
  savePhoto(shotTaken(blob, rotation, shotFov));
  updateHUD();
}

async function packPhotos() {
  const files = [];
  const entries = [];
  const fovSources = new Set();
  for (const p of photos) {
    const blob = await readPhoto(p);
    if (!blob) throw new Error(`falta a foto ${photoKey(p) + 1} no armazenamento`);
    const l = String(p.level + 1).padStart(2, "0");
    const s = String(p.shot + 1).padStart(2, "0");
    const name = `360_photos/level_${l}_shot_${s}.jpg`;
    files.push({ name, blob });
    if (p.fov && p.fov.source) fovSources.add(p.fov.source);
    entries.push({
      file: name,
      level: p.level + 1,
      shot: p.shot + 1,
      tilt: LEVEL_TARGETS[p.level],
      fov: p.fov || null,
      rotation: p.rotation || null,
      target: p.target || null,
    });
  }

  const doc = {
    format: "guided-360-capture/v1",
    generated: new Date().toISOString(),
    shotLayout: { tiltDegrees: LEVEL_TARGETS, shotsPerLevel: LEVEL_SHOTS },
    fovSource: fovSources.size === 1 ? [...fovSources][0] : "mixed",
    conventions: {
      rotation: "yaw/clkwise-from-level-reference, pitch above horizon, roll about the optical axis, all degrees",
      matrix: "row-major 3x3 device-to-world; world X east, Y north, Z up; camera axis is device -Z",
      fov: "rectilinear degrees; horizontal across width, vertical across height, for the stored orientation",
    },
    photos: entries,
  };
  files.push({ name: "metadata.json", blob: new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }) });

  return buildZip(files);
}

stitchBtn.addEventListener("click", async () => {
  const label = stitchBtn.textContent;
  stitchBtn.disabled = true;
  stitchBtn.textContent = "Preparando…";
  let content;
  try {
    content = await packPhotos();
  } catch (err) {
    alert("Falha ao criar o ZIP: " + err.message);
    return;
  } finally {
    stitchBtn.disabled = false;
    stitchBtn.textContent = label;
  }
  leaveCapture();
  stitchCapture(content);
});

exportBtn.addEventListener("click", async () => {
  const label = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "Preparando…";
  try {
    const content = await packPhotos();
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "360_photos.zip";
    // Not revoked: Opera only reads the URL once the user confirms its download prompt,
    // and a revoked one crashed it.
    a.click();
    exportBtn.textContent = "Baixado!";
  } catch (err) {
    alert("Falha ao criar o ZIP: " + err.message);
    exportBtn.disabled = false;
    exportBtn.textContent = label;
  }
});
