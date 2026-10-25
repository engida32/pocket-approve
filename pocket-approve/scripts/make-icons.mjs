import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = new URL("../public/", import.meta.url).pathname;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size, maskable = false) {
  const rows = [];
  const scale = maskable ? 0.78 : 0.94;
  const cx = size / 2;
  const cy = size / 2;
  const point = (x, y) => [cx + (x - 0.5) * size * scale, cy + (y - 0.5) * size * scale];
  const [ax, ay] = point(0.27, 0.52);
  const [bx, by] = point(0.44, 0.68);
  const [cx2, cy2] = point(0.74, 0.34);
  const stroke = size * 0.095 * (maskable ? 0.9 : 1);
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      const d = Math.min(
        distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by),
        distanceToSegment(x + 0.5, y + 0.5, bx, by, cx2, cy2),
      );
      const at = 1 + x * 4;
      const inside = d <= stroke / 2;
      row[at] = inside ? 245 : 17;
      row[at + 1] = inside ? 245 : 17;
      row[at + 2] = inside ? 242 : 17;
      row[at + 3] = 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(OUT, { recursive: true });
for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
]) {
  await writeFile(join(OUT, name), render(size, maskable));
}
console.log("Wrote public/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png");
