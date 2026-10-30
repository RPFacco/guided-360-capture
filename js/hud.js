import { LEVEL_TARGETS, LEVEL_SHOTS, TOTAL_SHOTS, shotsBefore, currentLevel, currentShot, refShot, photos, yawStep, spinTarget } from "./session.js";
import { gyroActive, displayYaw, angleDiff } from "./orientation.js";
import { hasVFC, frameSeq, previewLabel, exposureLabel, shotW, shotH } from "./camera.js";
import { drawDomeBase } from "./dome.js";

const TOLERANCE = 5;
// 6 degrees of slop still leaves the neighbours overlapping by over a third on a
// typical phone lens.
export const YAW_TOLERANCE = 6;

const $ = (id) => document.getElementById(id);
const progressFill = $("progress-fill");
const levelLabel = $("level-label"), shotCounter = $("shot-label");
const prompt = $("prompt");
const captureBtn = $("capture-btn"), exportBtn = $("export-btn"), stitchBtn = $("stitch-btn");
const perf = $("perf");

export let tiltAligned = false;
let spinAligned = false;
let lastReady = null;
let shotLabel = "—", fpsText = "…";
let uiFrames = 0, fpsAt = 0, fpsSeq = 0;

export function updatePerf() {
  perf.textContent = "FPS " + fpsText + " · Preview " + previewLabel + " · Shot " + shotLabel + " · Exposure " + exposureLabel;
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
  tiltAligned = Math.abs(pitch - LEVEL_TARGETS[currentLevel]) <= TOLERANCE;
  refreshReady();
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
  // Reference shot: nothing to rotate from yet.
  spinAligned = target === null || displayYaw === null || currentShot === refShot
      || Math.abs(angleDiff(displayYaw, target)) <= YAW_TOLERANCE;
  refreshReady();
}

// No sensor: the shutter stays lit, and the dome becomes a progress map without cursor.
export function waiveAlignment() {
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
    prompt.textContent = "All set. Stitch the panorama or download the photos.";
    captureBtn.classList.add("hidden");
    stitchBtn.classList.remove("hidden");
    exportBtn.classList.remove("hidden");
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
}
