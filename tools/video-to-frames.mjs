// Extract stitchable frames from a video_probe folder (or its unzipped zip).
//
// For every marker in video/metadata.json it decodes the 0.8 s hold that ended at the
// marker, scores each frame with the same acutance metric the capture uses, keeps the
// sharpest, and writes level_XX_shot_YY.jpg plus a metadata.json and a pano.pto that
// Hugin can open. The video FOV is unknown, so the pto starts from the assumed 53 deg
// lens and Hugin should optimize it.
//
// Usage:
//   node tools/video-to-frames.mjs <folder> [--out frames] [--width 8000] [--window 0.8]
//
// <folder> is the folder that holds video/metadata.json (the unzipped video_probe.zip).
// ffmpeg and ffprobe must be on PATH.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { acutance, isBlurry } from "../js/sharpness.js";
import { assumedFov } from "../js/fov.js";
import { buildPto, DEFAULT_PANO_WIDTH } from "../js/pto.js";

const ANALYSIS_W = 240, ANALYSIS_H = 320;
const SHOT_AR = 3 / 4;

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node tools/video-to-frames.mjs <video_probe folder> [--out frames] [--width 8000] [--window 0.8]");
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { folder: null, out: "frames", width: DEFAULT_PANO_WIDTH, window: 0.8 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") opts.out = rest[++i];
    else if (a === "--width") opts.width = Number(rest[++i]);
    else if (a === "--window") opts.window = Number(rest[++i]);
    else if (a.startsWith("--")) usage("unknown option: " + a);
    else if (!opts.folder) opts.folder = a;
    else usage("unexpected argument: " + a);
  }
  if (!opts.folder) usage();
  if (!Number.isFinite(opts.width) || opts.width < 2) usage("bad --width");
  if (!Number.isFinite(opts.window) || opts.window < 0.1 || opts.window > 3) usage("bad --window");
  return opts;
}

function run(bin, args, maxBuffer = 8 * 1024 * 1024) {
  return execFileSync(bin, args, { maxBuffer });
}

function ffprobe(file) {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,duration",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ], 1024 * 1024);
  const info = JSON.parse(out.toString("utf8"));
  const s = (info.streams && info.streams[0]) || {};
  const [n, d] = String(s.avg_frame_rate || "30/1").split("/").map(Number);
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: d ? n / d : 30,
    duration: Number(info.format && info.format.duration) || Number(s.duration) || 0,
  };
}

// The preview is a 3:4 portrait crop of the recorded frame. Crop the same way so the
// metric and the saved JPEG see what the user saw.
function cropFor(w, h) {
  if (!w || !h) return null;
  const ar = w / h;
  if (Math.abs(ar - SHOT_AR) < 0.02) return null;
  if (ar > SHOT_AR) {
    const cw = Math.round(h * SHOT_AR);
    return { w: cw, h, x: Math.round((w - cw) / 2), y: 0 };
  }
  const ch = Math.round(w / SHOT_AR);
  return { w, h: ch, x: 0, y: Math.round((h - ch) / 2) };
}

const cropFilter = (c) => (c ? `crop=${c.w}:${c.h}:${c.x}:${c.y}` : null);

// Decode the whole window at analysis size, [frame index, score] pairs.
function scoreWindow(file, start, take, crop) {
  const filters = [cropFilter(crop), `scale=${ANALYSIS_W}:${ANALYSIS_H}`].filter(Boolean).join(",");
  const buf = run("ffmpeg", [
    "-hide_banner", "-loglevel", "quiet", "-xerror", "-fflags", "+genpts",
    "-ss", start.toFixed(3), "-i", file, "-t", take.toFixed(3),
    "-an", "-vf", filters, "-vsync", "0",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], 64 * 1024 * 1024);

  const frameBytes = ANALYSIS_W * ANALYSIS_H * 3;
  const count = Math.floor(buf.length / frameBytes);
  const rgba = new Uint8ClampedArray(ANALYSIS_W * ANALYSIS_H * 4);
  const frames = [];
  for (let f = 0; f < count; f++) {
    const off = f * frameBytes;
    for (let i = 0, j = off; i < ANALYSIS_W * ANALYSIS_H; i++, j += 3) {
      rgba[i * 4] = buf[j];
      rgba[i * 4 + 1] = buf[j + 1];
      rgba[i * 4 + 2] = buf[j + 2];
      rgba[i * 4 + 3] = 255;
    }
    const s = acutance(rgba, ANALYSIS_W, ANALYSIS_H);
    if (s) frames.push({ index: f, ...s });
  }
  return frames;
}

function extractFrame(file, start, take, index, crop, out) {
  const select = `select=eq(n\\,${index})`;
  const filters = [select, cropFilter(crop)].filter(Boolean).join(",");
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(3), "-i", file, "-t", take.toFixed(3),
    "-an", "-vf", filters, "-frames:v", "1", "-vsync", "0",
    "-q:v", "2", out,
  ], 8 * 1024 * 1024);
}

// Fallback when the frame-index select misses (VFR timestamps can drift between passes).
function extractAtTime(file, sec, crop, out) {
  const filters = [cropFilter(crop)].filter(Boolean).join(",");
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", sec.toFixed(3), "-i", file,
    "-frames:v", "1", "-an",
  ];
  if (filters) args.push("-vf", filters);
  args.push("-q:v", "2", out);
  run("ffmpeg", args, 8 * 1024 * 1024);
}

const pad2 = (n) => String(n).padStart(2, "0");
const round4 = (v) => Math.round(v * 10000) / 10000;

function main() {
  const opts = parseArgs(process.argv);
  const folder = path.resolve(opts.folder);
  const metaPath = [path.join(folder, "video", "metadata.json"), path.join(folder, "metadata.json")]
      .find((p) => fs.existsSync(p));
  if (!metaPath) usage("no video/metadata.json (or metadata.json) under " + folder);

  const base = path.dirname(metaPath);
  const doc = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const clips = Array.isArray(doc.clips) ? doc.clips : [];
  if (!clips.length) usage("metadata has no clips");

  const outDir = path.resolve(folder, opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  const photos = [];
  const report = [];
  const used = new Set();
  let extracted = 0, blurry = 0, skipped = 0;

  for (const clip of clips) {
    const file = path.join(base, path.basename(clip.file || ""));
    if (!clip.file || !fs.existsSync(file)) {
      console.warn(`skip clip ${clip.level}: missing ${file}`);
      skipped += (clip.markers || []).length;
      continue;
    }
    const info = ffprobe(file);
    // Fragmented MP4 (MediaRecorder) can report duration 0; fall back to the last marker.
    const duration = info.duration > 0
        ? info.duration
        : (Math.max(0, ...(clip.markers || []).map((m) => (typeof m.t === "number" ? m.t : 0))) / 1000) + 1;
    const crop = cropFor(info.width, info.height);
    const outW = crop ? crop.w : info.width;
    const outH = crop ? crop.h : info.height;
    console.log(`\nclip ${clip.level} ${path.basename(file)} ${info.width}x${info.height} ${duration.toFixed(2)}s${crop ? ` -> crop ${crop.w}x${crop.h}` : ""}`);

    for (const marker of clip.markers || []) {
      if (typeof marker.t !== "number" || !Number.isFinite(marker.t)) {
        console.warn(`  skip level ${marker.level} shot ${marker.shot}: no marker time`);
        skipped++;
        continue;
      }
      // The marker fires when the 800 ms hold completes, so look back over the hold
      // rather than centring the window on the marker and catching the next pan.
      const start = Math.min(Math.max(0, marker.t / 1000 - opts.window), Math.max(0, duration - opts.window));
      const take = Math.min(opts.window, Math.max(0, duration - start));
      if (take <= 0) {
        console.warn(`  skip level ${marker.level} shot ${marker.shot}: no window left`);
        skipped++;
        continue;
      }

      const frames = scoreWindow(file, start, take, crop);
      if (!frames.length) {
        console.warn(`  skip level ${marker.level} shot ${marker.shot}: no decoded frames`);
        skipped++;
        continue;
      }
      const best = frames.reduce((a, b) => (b.score > a.score ? b : a));

      let name = `level_${pad2(marker.level)}_shot_${pad2(marker.shot)}.jpg`;
      if (used.has(name)) name = `level_${pad2(marker.level)}_shot_${pad2(marker.shot)}_clip${pad2(clip.id || 0)}.jpg`;
      used.add(name);
      const out = path.join(outDir, name);
      const tSec = start + best.index / (info.fps || 30);
      try {
        extractFrame(file, start, take, best.index, crop, out);
        if (!fs.existsSync(out)) throw new Error("select produced no frame");
      } catch (_) {
        try {
          extractAtTime(file, tSec, crop, out);
        } catch (err) {
          console.warn(`  extract failed for ${name}: ${err.message}`);
          skipped++;
          continue;
        }
      }

      const score = { score: round4(best.score), edge: round4(best.edge), contrast: round4(best.contrast) };
      const bad = isBlurry(score, null);
      if (bad) blurry++;
      extracted++;

      const fov = { ...assumedFov(outW, outH), width: outW, height: outH, orientation: 1, source: "assumed-video" };
      photos.push({
        file: name,
        level: marker.level,
        shot: marker.shot,
        tilt: doc.shotLayout && doc.shotLayout.tiltDegrees ? doc.shotLayout.tiltDegrees[marker.level - 1] : null,
        fov,
        rotation: marker.rotation || null,
        target: { pitch: doc.shotLayout ? doc.shotLayout.tiltDegrees?.[marker.level - 1] : null, heading: null },
        sharpness: score,
        blurry: bad,
        video: {
          clip: clip.file,
          clipId: clip.id || null,
          markerMs: marker.t,
          windowStartMs: Math.round(start * 1000),
          frameIndex: best.index,
          approxTimeMs: Math.round(tSec * 1000),
        },
      });
      report.push({ level: marker.level, shot: marker.shot, file: name, frameIndex: best.index, approxTimeMs: Math.round(tSec * 1000), ...score, blurry: bad });
      console.log(`  L${marker.level} S${String(marker.shot).padStart(2, "0")}  t=${(marker.t / 1000).toFixed(2)}s  frame ${best.index} ~${tSec.toFixed(2)}s  score ${score.score}${bad ? "  BLURRY" : ""}`);
    }
  }

  if (!photos.length) throw new Error("no frames extracted");

  const outDoc = {
    format: "guided-360-capture/v1",
    source: "video-probe",
    generated: new Date().toISOString(),
    device: doc.device || null,
    shotLayout: doc.shotLayout || null,
    fovSource: "assumed-video",
    conventions: {
      rotation: "yaw/clockwise-from-level-reference, pitch above horizon, roll about the optical axis, all degrees",
      matrix: "row-major 3x3 device-to-world; world X east, Y north, Z up; camera axis is device -Z",
      fov: "assumed 53 deg across the short edge; the video FOV is not measurable, so optimize v in Hugin",
    },
    photos,
  };

  fs.writeFileSync(path.join(outDir, "metadata.json"), JSON.stringify(outDoc, null, 2));
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
    input: metaPath,
    generated: new Date().toISOString(),
    extracted,
    blurry,
    skipped,
    assumedFov: 53,
    frames: report,
  }, null, 2));

  let ptoError = null;
  try {
    const pto = buildPto(outDoc, { width: opts.width, input: path.basename(metaPath) });
    fs.writeFileSync(path.join(outDir, "pano.pto"), pto);
  } catch (err) {
    ptoError = err.message;
  }

  console.log(`\n${extracted} frames -> ${outDir}`);
  if (blurry) console.log(`${blurry} frame(s) scored as blurry`);
  if (skipped) console.log(`${skipped} marker(s) skipped`);
  console.log(ptoError ? `pano.pto skipped: ${ptoError}` : "pano.pto written (assumed 53 deg FOV; optimize v in Hugin)");
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message);
  process.exit(1);
}
