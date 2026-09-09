import { deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

function crc32(data: Uint8Array) {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const content = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, crc]);
}
const output = join(import.meta.dir, "../public");
await mkdir(output, { recursive: true });
const points = [
  [156, 216],
  [212, 264],
  [156, 312],
];
for (const size of [192, 512]) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x * 512) / size,
        py = (y * 512) / size;
      let distance = Infinity;
      for (let n = 1; n < points.length; n++) {
        const [ax, ay] = points[n - 1],
          [bx, by] = points[n];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) /
              ((bx - ax) ** 2 + (by - ay) ** 2),
          ),
        );
        distance = Math.min(
          distance,
          Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)),
        );
      }
      const frame = px >= 92 && px <= 420 && py >= 108 && py <= 404;
      const border =
        frame &&
        (px < 100 ||
          px > 412 ||
          py < 116 ||
          py > 396 ||
          Math.abs(py - 160) < 4);
      const cursor = px >= 252 && px <= 344 && Math.abs(py - 320) < 11;
      const color =
        distance < 11 || cursor
          ? [255, 209, 40]
          : border
            ? [115, 119, 126]
            : frame
              ? [16, 19, 24]
              : [9, 12, 18];
      const offset = y * (1 + size * 3) + 1 + x * 3;
      raw.set(color, offset);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  await Bun.write(
    join(output, `icon-${size}.png`),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
