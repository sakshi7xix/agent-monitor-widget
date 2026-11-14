#!/usr/bin/env node
'use strict';
// Draws the tray icons (a pixel face) as PNG files with no dependencies.
//   node scripts/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GRID = [
  '.########.',
  '##########',
  '##########',
  '##oo##oo##',
  '##oo##oo##',
  '##########',
  '###oooo###',
  '###oooo###',
  '##########',
  '.########.',
];
const SCALE = 3; // 10 x 3 = 30px, centred in 32px

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const TABLE = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(fill, ink) {
  const size = 32;
  const offset = (size - GRID.length * SCALE) / 2;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - offset) / SCALE);
      const gy = Math.floor((y - offset) / SCALE);
      const cell = GRID[gy]?.[gx];
      const color = cell === '#' ? fill : cell === 'o' ? ink : null;
      const at = y * (size * 4 + 1) + 1 + x * 4;
      if (color) raw.set([...color, 255], at);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const INK = [11, 13, 16];
fs.writeFileSync(path.join(out, 'tray.png'), png([61, 220, 151], INK)); // green: all quiet
fs.writeFileSync(path.join(out, 'tray-alert.png'), png([245, 176, 65], INK)); // amber: needs you
console.log('Wrote assets/tray.png and assets/tray-alert.png');
