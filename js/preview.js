// Quick 360 preview made on the phone, so nobody waits in the server's queue to see
// their panorama. Every photo is projected onto an equirectangular image at the pose
// the sensors recorded. There is no feature matching, so seams can be a few degrees
// off; the server's stitch refines the poses and blends properly.
//
// The math mirrors the backend (stitch.sensor_poses and align.rotation), so the
// preview is laid out like the final panorama and opens the same way in the viewer.
// No imports: the projection runs in Node for tests.

const DEG = Math.PI / 180;
const PREVIEW_WIDTH = 2048; // equirectangular, 2:1
const PHOTO_EDGE = 512;     // long edge the photos are shrunk to before projecting
const EMPTY = 40;           // grey where no photo reaches

// shots: [{ rotation, fov, tilt }], tilt being the level's target pitch.
export const canPreview = (shots) =>
  shots.length > 0 && shots.every((s) => s.rotation && s.fov && s.fov.horizontal);

// Hugin's angles, as stitch.sensor_poses computes them: yaw relative to the first
// horizon photo, roll flipped.
export function sensorPoses(shots) {
  const reference = shots.find((s) => s.tilt === 0)?.rotation.yaw ?? 0;
  return shots.map(({ rotation: r }) => ({
    yaw: ((((r.yaw - reference + 180) % 360) + 360) % 360) - 180,
    pitch: r.pitch,
    roll: -r.roll,
  }));
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Camera axes in world coordinates (X right, Y ahead, Z up), as align.rotation builds them.
function cameraAxes({ yaw, pitch, roll }) {
  const y = yaw * DEG, p = pitch * DEG, rho = -roll * DEG;
  const forward = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  const right0 = [Math.cos(y), -Math.sin(y), 0];
  const up0 = cross(right0, forward);
  const c = Math.cos(rho), s = Math.sin(rho);
  return {
    right: right0.map((v, i) => c * v + s * up0[i]),
    up: right0.map((v, i) => -s * v + c * up0[i]),
    forward,
  };
}

export function createPanorama(width = PREVIEW_WIDTH) {
  const height = width / 2;
  const lon = Float64Array.from({ length: width }, (_, i) => ((i + 0.5) / width * 2 - 1) * Math.PI);
  const lat = Float64Array.from({ length: height }, (_, j) => (0.5 - (j + 0.5) / height) * Math.PI);
  return {
    width, height,
    sinLon: lon.map(Math.sin), cosLon: lon.map(Math.cos),
    sinLat: lat.map(Math.sin), cosLat: lat.map(Math.cos),
    sum: new Float32Array(width * height * 3),
    weight: new Float32Array(width * height),
  };
}

// Adds one photo ({ data: RGBA, width, height }) to the panorama. hfov is in degrees,
// across the photo's width.
export function addPhoto(pano, image, pose, hfov) {
  const { width: W, height: H, sinLon, cosLon, sinLat, cosLat, sum, weight } = pano;
  const { data, width: w, height: h } = image;
  const { right: [rx, ry, rz], up: [ux, uy, uz], forward: [fx, fy, fz] } = cameraAxes(pose);
  const f = w / 2 / Math.tan(hfov * DEG / 2);
  const reach = Math.atan(Math.hypot(w, h) / 2 / f); // every pixel is within this of the axis
  const cosReach = Math.cos(reach);
  const latC = Math.asin(Math.max(-1, Math.min(1, fz)));
  const lonC = Math.atan2(fx, fy);
  const sinC = Math.sin(latC), cosC = Math.cos(latC);
  const halfW = w / 2, halfH = h / 2, xMax = w - 1, yMax = h - 1, stride = w * 4;

  const j0 = Math.max(0, Math.floor((0.5 - (latC + reach) / Math.PI) * H));
  const j1 = Math.min(H - 1, Math.ceil((0.5 - (latC - reach) / Math.PI) * H));
  for (let j = j0; j <= j1; j++) {
    const sl = sinLat[j], cl = cosLat[j];

    // Only the columns where the cone around the axis crosses this row.
    let k0 = 0, k1 = W - 1;
    const denom = cl * cosC;
    if (denom > 1e-6) {
      const c = (cosReach - sl * sinC) / denom;
      if (c >= 1) continue;
      if (c > -1) {
        const span = Math.acos(c);
        k0 = Math.floor(((lonC - span) / Math.PI + 1) / 2 * W - 0.5);
        k1 = Math.ceil(((lonC + span) / Math.PI + 1) / 2 * W - 0.5);
        if (k1 - k0 >= W) { k0 = 0; k1 = W - 1; }
      }
    }

    const row = j * W;
    for (let k = k0; k <= k1; k++) {
      const i = k < 0 ? k + W : k >= W ? k - W : k;
      const dx = sinLon[i] * cl, dy = cosLon[i] * cl;
      const z = fx * dx + fy * dy + fz * sl;
      if (z <= cosReach) continue;
      const x = (rx * dx + ry * dy + rz * sl) / z * f + halfW;
      const y = halfH - (ux * dx + uy * dy + uz * sl) / z * f;
      if (!(x >= 0 && y >= 0 && x < xMax && y < yMax)) continue;

      // edge^8 fades each photo out close to its border, so overlaps blend over a
      // narrow band: a wide blend ghosts the few degrees the sensors are off. The tiny
      // floor keeps a border pixel that only one photo covers from rounding to "empty".
      const edge = Math.min(Math.min(x, xMax - x) / halfW, Math.min(y, yMax - y) / halfH);
      const e2 = edge * edge, e4 = e2 * e2;
      const wgt = e4 * e4 + 1e-20;

      const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0;
      const w00 = (1 - ax) * (1 - ay) * wgt, w10 = ax * (1 - ay) * wgt;
      const w01 = (1 - ax) * ay * wgt, w11 = ax * ay * wgt;
      const p = y0 * stride + x0 * 4, q = p + stride;
      const o = (row + i) * 3;
      sum[o] += data[p] * w00 + data[p + 4] * w10 + data[q] * w01 + data[q + 4] * w11;
      sum[o + 1] += data[p + 1] * w00 + data[p + 5] * w10 + data[q + 1] * w01 + data[q + 5] * w11;
      sum[o + 2] += data[p + 2] * w00 + data[p + 6] * w10 + data[q + 2] * w01 + data[q + 6] * w11;
      weight[row + i] += wgt;
    }
  }
}

export function finishPanorama({ width, height, sum, weight }) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let n = 0; n < width * height; n++) {
    const wgt = weight[n], o = n * 4;
    if (wgt > 0) {
      out[o] = sum[n * 3] / wgt;
      out[o + 1] = sum[n * 3 + 1] / wgt;
      out[o + 2] = sum[n * 3 + 2] / wgt;
    } else {
      out[o] = out[o + 1] = out[o + 2] = EMPTY;
    }
    out[o + 3] = 255;
  }
  return out;
}

// An <img> rather than createImageBitmap, which leaked memory on iOS. Not img.decode()
// either: Chrome then decodes the full 8-12 MP twice, while a plain drawImage decodes
// straight to the small size (half the time). One canvas for every photo, resized
// only when the size changes (reallocs leak on iOS too).
async function shrink(blob, canvas, ctx) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("foto ilegível"));
      img.src = url;
    });
    const scale = Math.min(1, PHOTO_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
    img.src = "";
  }
}

// readBlob(n) gives the n-th shot's photo. Resolves to a JPEG blob.
export async function renderPreview(shots, readBlob, onProgress = () => {}) {
  const poses = sensorPoses(shots);
  const pano = createPanorama();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  try {
    for (let n = 0; n < shots.length; n++) {
      const blob = await readBlob(n);
      if (!blob) throw new Error(`falta a foto ${n + 1}`);
      addPhoto(pano, await shrink(blob, canvas, ctx), poses[n], shots[n].fov.horizontal);
      onProgress((n + 1) / shots.length);
      await new Promise((resolve) => setTimeout(resolve)); // let the progress paint
    }
  } finally {
    canvas.width = canvas.height = 0;
  }

  const out = document.createElement("canvas");
  out.width = pano.width;
  out.height = pano.height;
  out.getContext("2d").putImageData(new ImageData(finishPanorama(pano), pano.width, pano.height), 0, 0);
  const jpeg = await new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.85));
  out.width = out.height = 0;
  if (!jpeg) throw new Error("não foi possível gerar o JPEG");
  return jpeg;
}
