const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Stored (uncompressed) zip, by hand. Not deflated: JPEGs don't compress, and deflating
// a 40-photo set in one pass was enough to push mobile Safari over its memory limit.
// Each entry is just a header plus the photo, so the photo Blobs go into new Blob() as
// parts instead of being copied into one buffer. The only read is each photo's CRC.
export async function buildZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(new Uint8Array(await f.blob.arrayBuffer()));
    const size = f.blob.size;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, f.blob);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, name);

    offset += 30 + name.length + size;
  }

  const dirSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// Reads a zip's directory without loading the file: a 300 MB capture only costs the
// entries actually read. Stored entries (what buildZip writes) are slices of the file;
// deflated ones, from a zip someone re-packed, are inflated where the browser has
// DecompressionStream. Null for anything that is not a plain zip (ZIP64 included).
export async function readZip(file) {
  const tailSize = Math.min(file.size, 22 + 0xFFFF); // end record + longest comment
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let end = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = tail.getUint16(end + 10, true);
  const dirSize = tail.getUint32(end + 12, true);
  const dirOffset = tail.getUint32(end + 16, true);
  if (count === 0xFFFF || dirOffset === 0xFFFFFFFF) return null;

  const dir = new DataView(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== 0x02014b50) return null;
    const nameLength = dir.getUint16(p + 28, true);
    const skip = nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    entries.set(dec.decode(new Uint8Array(dir.buffer, p + 46, nameLength)), {
      encrypted: dir.getUint16(p + 8, true) & 1,
      method: dir.getUint16(p + 10, true),
      size: dir.getUint32(p + 20, true),
      offset: dir.getUint32(p + 42, true),
    });
    p += 46 + skip;
  }

  return {
    has: (name) => entries.has(name),
    // Resolves to the entry's bytes as a Blob, or null if it is missing or unreadable.
    async read(name, type = "") {
      const e = entries.get(name);
      if (!e || e.encrypted) return null;
      const local = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
      if (local.byteLength < 30 || local.getUint32(0, true) !== 0x04034b50) return null;
      const start = e.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const data = file.slice(start, start + e.size, type);
      if (e.method === 0) return data;
      if (e.method !== 8 || typeof DecompressionStream !== "function") return null;
      const inflated = await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      return type ? new Blob([inflated], { type }) : inflated;
    },
  };
}
