// Raster variants of the hand-authored LifeOS icon for installable PWA manifests.
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, check]);
};
for (const size of [192, 512]) {
  const image = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const X = (x / size) * 512,
        Y = (y / size) * 512;
      let color = [119, 89, 219, 255];
      if (
        (X >= 142 && X < 214 && Y >= 130 && Y < 382) ||
        (X >= 142 && X < 370 && Y >= 314 && Y < 382)
      )
        color = [255, 255, 255, 255];
      if (X >= 272 && X < 370 && Y >= 130 && Y < 228) color = [199, 183, 255, 255];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      image.set(color, offset);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    `public/icons/icon-${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(image)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
