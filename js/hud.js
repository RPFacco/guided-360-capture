import { LEVEL_TARGETS, LEVEL_SHOTS, TOTAL_SHOTS, shotsBefore, currentLevel, currentShot, refShot, photos, yawStep, spinTarget } from "./session.js";
import { ROTATION_SIGN, gyroActive, displayYaw, angleDiff } from "./orientation.js";
import { hasVFC, frameSeq, previewLabel, shotW, shotH } from "./camera.js";
import { drawDomeBase } from "./dome.js";

const TOLERANCE = 5;
const RANGE = 25;
// 6 degrees of slop still leaves the neighbours overlapping by over a third on a
// typical phone lens.
export const YAW_TOLERANCE = 6;

const $ = (id) => document.getElementById(id);
const progressFill = $("progress-fill");
const levelLabel = $("level-label"), shotCounter = $("shot-label");
const tilt = $("tilt"), bubble = $("tilt-bubble"), angleEl = $("angle");
const spin = $("spin"), spinBubble = $("spin-bubble"), spinDeg = $("spin-deg");
const prompt = $("prompt");
const captureBtn = $("capture-btn"), exportBtn = $("export-btn");
const perf = $("perf");

export let tiltAligned = false;
let spinAligned = false;
let lastAngleShown = null, lastAligned = null;
let lastSpinShown = null, lastSpinAligned = null;
let lastReady = null;
let shotLabel = "—", fpsText = "…";
let uiFrames = 0, fpsAt = 0, fpsSeq = 0;

export function updatePerf() {
  perf.textContent = "FPS " + fpsText + " · Preview " + previewLabel + " · Shot " + shotLabel;
}

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "MB" : Math.round(bytes / 1024) + "KB";
}

export function showShot(bytes) {
  shotLabel = (shotW ? shotW + "×" + shotH + " " : "") + "(" + fmtSize(bytes) + ")";
  updatePerf();
}

export function countFrame(now) {
  uiFrames++;
  if (!fpsAt) fpsAt = now;
  if (now - fpsAt < 1000) return;
  fpsText = String(hasVFC ? frameSeq - fpsSeq : uiFrames);
  uiFrames = 0;
  fpsSeq = frameSeq;
  fpsAt = now;
  updatePerf();
}

export function setPrompt(text) {
  prompt.textContent = text;
}

export function updateTilt(pitch) {
  const target = LEVEL_TARGETS[currentLevel];
  const diff = pitch - target;

  const half = 97;
  const clamped = Math.max(-RANGE, Math.min(RANGE, diff));
  const offset = -(clamped / RANGE) * half;
  bubble.style.transform = `translate(-50%, calc(-50% + ${offset.toFixed(1)}px))`;

  const deg = Math.round(pitch);
  if (deg !== lastAngleShown) {
    angleEl.textContent = (deg > 0 ? "+" : "") + deg + "°";
    lastAngleShown = deg;
  }

  const aligned = Math.abs(diff) <= TOLERANCE;
  if (aligned !== lastAligned) {
    tilt.classList.toggle("aligned", aligned);
    tiltAligned = aligned;
    refreshReady();
    lastAligned = aligned;
  }
}

// The shutter goes green only when both axes agree. Advisory only: a drifting sensor
// must never be able to block a shot.
function refreshReady() {
  const ready = tiltAligned && spinAligned;
  if (ready === lastReady) return;
  captureBtn.classList.toggle("ready", ready);
  lastReady = ready;
}

export function updateSpin() {
  const target = spinTarget();
  if (target === null || displayYaw === null || currentShot === refShot) {
    // Reference shot: nothing to rotate from yet.
    if (!spinAligned) { spinAligned = true; refreshReady(); }
    lastSpinAligned = null;
    return;
  }

  const diff = angleDiff(displayYaw, target);

  const half = 97;
  const range = yawStep(); // gauge spans one step: just shot at the edge, target at the centre
  const clamped = Math.max(-range, Math.min(range, diff));
  const offset = (clamped / range) * half;
  spinBubble.style.transform = `translate(calc(-50% + ${offset.toFixed(1)}px), -50%)`;

  const deg = Math.round(-diff * ROTATION_SIGN); // degrees still to go, counting down to 0
  if (deg !== lastSpinShown) {
    spinDeg.textContent = (deg > 0 ? "+" : "") + deg + "°";
    lastSpinShown = deg;
  }

  const aligned = Math.abs(diff) <= YAW_TOLERANCE;
  if (aligned !== lastSpinAligned) {
    spin.classList.toggle("aligned", aligned);
    spinAligned = aligned;
    refreshReady();
    lastSpinAligned = aligned;
  }
}

// No sensor: the shutter stays lit, and the dome becomes a progress map without cursor.
export function hideGauges() {
  tilt.classList.add("hidden");
  spin.classList.add("hidden");
  tiltAligned = spinAligned = true;
  refreshReady();
}

export function updateHUD() {
  const done = shotsBefore(currentLevel) + currentShot;
  progressFill.style.width = (done / TOTAL_SHOTS) * 100 + "%";
  drawDomeBase();

  if (done >= TOTAL_SHOTS) {
    levelLabel.textContent = "Done";
    shotCounter.textContent = photos.length + " photos";
    prompt.textContent = "All set. Download the pack below.";
    captureBtn.classList.add("hidden");
    exportBtn.classList.remove("hidden");
    tilt.classList.add("hidden");
    spin.classList.add("hidden");
    return;
  }

  const t = LEVEL_TARGETS[currentLevel];
  const tiltText = `${t > 0 ? "+" : ""}${t}°`;
  levelLabel.textContent = `Level ${currentLevel + 1} of ${LEVEL_TARGETS.length} (${tiltText})`;
  shotCounter.textContent = `Shot ${currentShot + 1} of ${LEVEL_SHOTS[currentLevel]}`;
  prompt.textContent = currentShot === 0
      ? (!gyroActive ? `Aim ~${tiltText} (no sensor)`
          : LEVEL_SHOTS[currentLevel] > 1 ? `Tilt to ${tiltText} and aim at the green ring`
          : `Tilt the phone to ${tiltText}`)
      : currentShot === refShot && gyroActive
      ? "Aim where your last photo was, then tap to recalibrate"
      : (gyroActive ? "Rotate right to the green ring" : `Rotate ~${yawStep()}° right (no sensor)`);

  spin.classList.toggle("hidden", !gyroActive || currentShot === refShot);
}
