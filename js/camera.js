import { exifFromBlob, fovFromFocal, assumedFov } from "./fov.js";

// takePhoto reconfigures the capture session on every shot: on iOS the preview goes
// black and each still allocates a sensor-sized buffer that kills the tab after a
// handful, on Android the preview freezes for up to a second. So every photo is a
// canvas grab of the preview frame.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const JPEG_QUALITY = 0.92;
const SHOT_AR = 3 / 4;  // width/height, in portrait
const LONG_EDGE = 4032; // the photo is the whole preview frame, up to 12MP

// Measured on a Xiaomi (Android 16): the still menu holds 2448x3264, 1920x2560 and
// 1440x1920 at a true 3:4, plus a 2256x4000 16:9 that is the DEFAULT and crops 25%
// off the width. So the lens probe asks for a size - never takePhoto()'s default.
const STILL_SETTINGS = { imageWidth: 3264, imageHeight: 2448 };

const EXPOSURE_SETTLE_MS = 800;
const EXPOSURE_MAX_CHANGE = 0.25;
const EXPOSURE_STEADY = 0.03; // the meter has settled once a reading moves less than this
const EXPOSURE_STEADY_TRIES = 15; // 200 ms apart

const video = document.getElementById("video");
let stream = null;
let frameLoopGen = 0;
let frameListener = () => {};
let exposureReady = Promise.resolve();

export const hasVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
export let frameSeq = 0;
export let previewLabel = "…";
export let exposureLabel = "automática";
export let shotW = 0, shotH = 0;
export let shotFov = null;
let probedFov = null;
let probePromise = null;

export function onFrame(listener) {
  frameListener = listener;
}

// Ask for ONE edge, never a width+height pair: Chrome/Android resolves a pair in sensor
// space and silently returns a landscape crop. Measured on a Xiaomi (Android 16),
// {width:exact 1440, height:exact 1920} came back 1920x1440 with the top and bottom
// cut off; the short edge alone returns a true portrait 3:4 track. iOS honours either.
// applyConstraints can lower a resolution but never raise it, so each rung is a fresh
// getUserMedia.
//
// The photo IS a preview frame, so iOS takes the biggest, down from 12MP. Android
// starts at 1440: the stitch shrinks every photo to 1440x1920 anyway.
function shortEdgeLadder() {
  return IS_IOS ? [3024, 2448, 1920, 1440, 1080] : [1440, 1920, 1080];
}

// A track can answer the right size with the wrong shape - {height: exact 720} came
// back 720x720 square on the Xiaomi - so check what arrived instead of trusting it.
function isPhotoShaped(s) {
  const ar = (s.width || 0) / (s.height || 1);
  return Math.abs(ar - SHOT_AR) < 0.02 || Math.abs(ar - 1 / SHOT_AR) < 0.02;
}

export function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

export async function startCamera() {
  stopCamera();

  const face = { ideal: "environment" };
  let lastErr = null;
  for (const h of shortEdgeLadder()) {
    let candidate = null;
    try {
      candidate = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, height: { exact: h } }, audio: false
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (isPhotoShaped(candidate.getVideoTracks()[0].getSettings())) {
      stream = candidate;
      break;
    }
    candidate.getTracks().forEach((t) => t.stop());
  }
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: face }, audio: false });
    } catch (err) {
      throw lastErr || err;
    }
  }

  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  const s2 = track.getSettings();
  previewLabel = s2.width + "×" + s2.height;
  await video.play().catch(() => {});

  startFrameLoop();
  exposureReady = lockExposure(track).catch(() => {});
}

const lumaCanvas = document.createElement("canvas");
lumaCanvas.width = lumaCanvas.height = 32;
const lumaCtx = lumaCanvas.getContext("2d", { willReadFrequently: true });

function meanLuma() {
  lumaCtx.drawImage(video, 0, 0, 32, 32);
  const d = lumaCtx.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / 1024;
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// Auto exposure is still converging after the camera (re)starts.
async function steadyLuma() {
  let last = meanLuma();
  for (let i = 0; i < EXPOSURE_STEADY_TRIES; i++) {
    await wait(200);
    const l = meanLuma();
    if (Math.abs(l - last) <= last * EXPOSURE_STEADY) return l;
    last = l;
  }
  return last;
}

async function lockExposure(track) {
  exposureLabel = "automática";
  const modes = !IS_IOS && track.getCapabilities ? track.getCapabilities().exposureMode : null;
  if (!modes || !modes.includes("manual")) return;

  // The lens probe's takePhoto restarts the session, and the metering with it.
  await probeStillFov();
  await wait(EXPOSURE_SETTLE_MS);
  if (!video.videoWidth || track.readyState !== "live") return;
  const before = await steadyLuma();
  if (track.readyState !== "live") return;
  const { iso } = track.getSettings();
  try {
    await track.applyConstraints({ advanced: [iso ? { exposureMode: "manual", iso } : { exposureMode: "manual" }] });
  } catch (_) {
    return;
  }

  await wait(EXPOSURE_SETTLE_MS);
  if (Math.abs(meanLuma() - before) > before * EXPOSURE_MAX_CHANGE) {
    await track.applyConstraints({ advanced: [{ exposureMode: "continuous" }] }).catch(() => {});
    exposureLabel = "automática (travar mudou o brilho)";
    return;
  }
  exposureLabel = "travada";
}

// Re-attaching srcObject cancels any pending requestVideoFrameCallback, so the loop
// has to be restartable. The generation token keeps a resurrected chain from running
// alongside an old one that turned out to be alive. The frame listener runs here, in
// step with the frame it draws over.
function startFrameLoop() {
  if (!hasVFC) return;
  const gen = ++frameLoopGen;
  const tick = () => {
    if (gen !== frameLoopGen) return;
    frameSeq++;
    video.requestVideoFrameCallback(tick); // re-armed first: a drawing error must not stop the loop
    frameListener();
  };
  video.requestVideoFrameCallback(tick);
}

export function resumePreview() {
  video.play().catch(() => {});
}

// iOS pauses the element under memory pressure and after a backgrounding.
video.addEventListener("pause", () => { if (stream) resumePreview(); });

// Resolves true as soon as a freshly decoded frame lands, false on timeout.
function waitForFrame(ms) {
  if (!hasVFC) return new Promise((res) => setTimeout(() => res(true), 60));
  const seen = frameSeq;
  return new Promise((res) => {
    const t0 = performance.now();
    const poll = () => {
      if (frameSeq !== seen) return res(true);
      if (performance.now() - t0 >= ms) return res(false);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

// After a canvas read-back WebKit sometimes drops the video compositing layer: the
// stream is still live, the element just paints black. Re-attaching srcObject hands
// it a fresh surface; only a genuinely dead track needs the session rebuilt.
async function recoverPreview() {
  if (video.paused) await video.play().catch(() => {});
  if (await waitForFrame(200)) return;

  video.srcObject = null;
  video.srcObject = stream;
  await video.play().catch(() => {});
  startFrameLoop();
  if (await waitForFrame(500)) return;

  try { await startCamera(); } catch (_) {}
}

async function setShotFov(blob) {
  if (probePromise) await probePromise;
  const exif = await exifFromBlob(blob);
  let w = shotW, h = shotH;
  if (!w || !h) { w = 3; h = 4; }
  const orientation = (exif && exif.orientation) || 1;
  if (orientation >= 5) { const t = w; w = h; h = t; }
  const f35 = (exif && exif.focal35mm) || (probedFov && probedFov.focal35mm) || null;
  const base = f35 ? fovFromFocal(f35, w, h) : assumedFov(w, h);
  if (f35 && !(exif && exif.focal35mm)) base.source = "exif-probe";
  shotFov = { ...base, width: w, height: h, orientation };
}

// Canvas grabs have no EXIF, so take a single throwaway still up front just to read
// the lens. It reconfigures the capture session once, which the canvas path can survive;
// the per-shot takePhoto is what kills the tab on iOS. Best effort, never blocks the run.
export function probeStillFov() {
  if (probePromise || !("ImageCapture" in window) || !stream) return probePromise;
  probePromise = (async () => {
    let probe = null;
    try { probe = new ImageCapture(stream.getVideoTracks()[0]); } catch (_) { return; }
    try {
      const blob = await Promise.race([
        IS_IOS ? probe.takePhoto() : probe.takePhoto(STILL_SETTINGS),
        new Promise((res) => setTimeout(() => res(null), 4000)),
      ]);
      if (blob) {
        const exif = await exifFromBlob(blob);
        if (exif && exif.focal35mm) probedFov = exif;
      }
    } catch (_) {
    } finally {
      await recoverPreview();
    }
  })();
  return probePromise;
}

// One reused canvas. Resize only when the frame size changes (realloc leaks on iOS).
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

// exposed() runs once the picture is fixed: from then on the phone may move.
export async function capturePhoto(exposed) {
  await exposureReady;

  // Never grab a stale frame: mid-recovery the preview draws black.
  if (video.paused) await video.play().catch(() => {});
  await waitForFrame(400);

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Target orientation comes from the SCREEN, not the frame. The preview is a fixed
  // 3:4 box using object-fit: cover, so deriving the crop the same way keeps what you
  // see and what is saved identical even if a driver hands back a landscape track.
  const ar = (window.innerHeight >= window.innerWidth) ? SHOT_AR : 1 / SHOT_AR;
  let sw = vw, sh = vh;
  if (vw / vh > ar) sw = Math.round(vh * ar);
  else sh = Math.round(vw / ar);
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);

  // Cap the long edge, then derive the short one so the ratio stays exact.
  const scale = Math.min(1, LONG_EDGE / Math.max(sw, sh));
  let w, h;
  if (sh >= sw) { h = Math.round(sh * scale); w = Math.round(h * ar); }
  else { w = Math.round(sw * scale); h = Math.round(w / ar); }

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  exposed();
  shotW = w;
  shotH = h;

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  await setShotFov(blob);
  await recoverPreview();
  return blob;
}
