import { LEVEL_TARGETS, LEVEL_SHOTS, TOTAL_SHOTS, shotsBefore, currentLevel, currentShot, photos, yawStep, headingLost } from "./session.js";
import { gyroActive } from "./orientation.js";
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
const undoBtn = $("undo-btn"), exportBtn = $("export-btn"), stitchBtn = $("stitch-btn");
const perf = $("perf");

export let tiltAligned = false;
let shotLabel = "—", fpsText = "…";
let uiFrames = 0, fpsAt = 0, fpsSeq = 0;

export function updatePerf() {
  perf.textContent = "FPS " + fpsText + " · Prévia " + previewLabel + " · Foto " + shotLabel + " · Exposição " + exposureLabel;
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
}

export function updateHUD() {
  const done = shotsBefore(currentLevel) + currentShot;
  progressFill.style.width = (done / TOTAL_SHOTS) * 100 + "%";
  drawDomeBase();

  // Heading lost: the same button recalibrates instead.
  const recal = headingLost() && gyroActive;
  undoBtn.textContent = recal ? "Recalibrar" : "Desfazer última foto";
  undoBtn.classList.toggle("recal", recal);
  undoBtn.disabled = !recal && !photos.length;

  if (done >= TOTAL_SHOTS) {
    levelLabel.textContent = "Pronto";
    shotCounter.textContent = photos.length + " fotos";
    prompt.textContent = "Tudo pronto. Costure o panorama ou baixe as fotos.";
    stitchBtn.classList.remove("hidden");
    exportBtn.classList.remove("hidden");
    return;
  }
  stitchBtn.classList.add("hidden");
  exportBtn.classList.add("hidden");

  const t = LEVEL_TARGETS[currentLevel];
  const tiltText = `${t > 0 ? "+" : ""}${t}°`;
  levelLabel.textContent = `Nível ${currentLevel + 1} de ${LEVEL_TARGETS.length} (${tiltText})`;
  shotCounter.textContent = `Foto ${currentShot + 1} de ${LEVEL_SHOTS[currentLevel]}`;
  prompt.textContent = currentShot === 0
      ? (!gyroActive ? `Aponte a ~${tiltText} (sem sensor)`
          : LEVEL_SHOTS[currentLevel] > 1 ? `Incline até ${tiltText} e mire no anel verde`
          : `Incline o celular até ${tiltText}`)
      : recal
      ? "Aponte para onde estava a última foto e toque em Recalibrar"
      : (gyroActive ? "Gire para a direita até o anel verde" : `Gire ~${yawStep()}° para a direita (sem sensor)`);
}
