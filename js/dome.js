import { LEVEL_TARGETS, LEVEL_SHOTS, shotsBefore, currentLevel, currentShot, levelStartYaw, headingLost } from "./session.js";
import { DEG, ROTATION_SIGN, gyroActive, displayPitch, displayYaw, angleDiff } from "./orientation.js";

const DOME_PX = 112; // keep in sync with .dome in style.css

// Coverage dome: one ring per level, one sector per shot, seen from above. The cells
// only change when a photo lands, so they are drawn once to their own canvas and each
// frame just blits it and adds the cursor.
const dome = document.getElementById("dome");
const domeBase = document.createElement("canvas");
const domeBaseCtx = domeBase.getContext("2d");
const domeCtx = dome.getContext("2d");
let domeR = 0, domeMid = 0, domeScale = 1;
let domeDirty = true, domeCursor = "";
export const domeInk = { accent: "#4c8dff", ok: "#34d17a" };

export function initDome() {
  domeScale = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(DOME_PX * domeScale);
  dome.width = domeBase.width = px;
  dome.height = domeBase.height = px;
  domeMid = px / 2;
  domeR = domeMid - 2 * domeScale; // room for the outer ring stroke

  // Same colours as style.css, read from its custom properties.
  const cs = getComputedStyle(document.documentElement);
  domeInk.accent = cs.getPropertyValue("--accent").trim() || domeInk.accent;
  domeInk.ok = cs.getPropertyValue("--ok").trim() || domeInk.ok;

  drawDomeBase();
}

function cellPath(ctx, level, sector) {
  const step = 360 / LEVEL_SHOTS[level];
  const r0 = domeR * level / LEVEL_TARGETS.length;
  const r1 = domeR * (level + 1) / LEVEL_TARGETS.length;
  const a0 = (sector * step - 90 - step / 2) * DEG; // sector 0 centred at the top
  const a1 = a0 + step * DEG;
  ctx.beginPath();
  ctx.arc(domeMid, domeMid, r1, a0, a1);
  // A single-shot level is a whole ring: no radial seam between its edges.
  if (step === 360) ctx.moveTo(domeMid + r0 * Math.cos(a1), domeMid + r0 * Math.sin(a1));
  ctx.arc(domeMid, domeMid, r0, a1, a0, true);
  ctx.closePath();
}

export function drawDomeBase() {
  if (!domeR) return;
  const ctx = domeBaseCtx;
  ctx.clearRect(0, 0, domeBase.width, domeBase.height);

  // Capture is sequential, so the filled cells are always the first `done` in order.
  const done = shotsBefore(currentLevel) + currentShot;
  for (let level = 0; level < LEVEL_TARGETS.length; level++) {
    for (let sector = 0; sector < LEVEL_SHOTS[level]; sector++) {
      const idx = shotsBefore(level) + sector;
      const isTarget = idx === done;
      cellPath(ctx, level, sector);
      if (idx < done) {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = domeInk.accent;
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(255,255,255,0.07)";
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = (isTarget ? 2 : 1) * domeScale;
      ctx.strokeStyle = isTarget ? domeInk.ok : "rgba(255,255,255,0.22)";
      ctx.stroke();
    }
  }
  domeDirty = true;
}

export function drawDome() {
  if (!domeR) return;

  // (112.5 - pitch) / 225 lands each LEVEL_TARGETS entry on the CENTRE of its ring
  // (+90 -> 0.1, 0 -> 0.5, -90 -> 0.9) rather than on the seam between two rings.
  // Heading lost: no cursor until the recalibration tap.
  const live = gyroActive && !headingLost() && displayPitch !== null && displayYaw !== null && levelStartYaw !== null;
  let x = 0, y = 0, key = "";
  if (live) {
    const r = Math.max(0, Math.min(1, (112.5 - displayPitch) / 225)) * domeR;
    const a = (ROTATION_SIGN * angleDiff(displayYaw, levelStartYaw) - 90) * DEG;
    x = domeMid + r * Math.cos(a);
    y = domeMid + r * Math.sin(a);
    key = Math.round(x) + ":" + Math.round(y);
  }
  if (!domeDirty && key === domeCursor) return;
  domeDirty = false;
  domeCursor = key;

  domeCtx.clearRect(0, 0, dome.width, dome.height);
  domeCtx.drawImage(domeBase, 0, 0);
  if (!live) return;

  domeCtx.beginPath();
  domeCtx.arc(x, y, 4 * domeScale, 0, Math.PI * 2);
  domeCtx.fillStyle = "#fff";
  domeCtx.fill();
  domeCtx.lineWidth = 2 * domeScale;
  domeCtx.strokeStyle = "rgba(0,0,0,0.55)";
  domeCtx.stroke();
}
