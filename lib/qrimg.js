'use strict';
/**
 * QR Code gerado no servidor, sem dependências nativas.
 *
 * O frontend do site monta o src assim:
 *   qrCodeBase64.startsWith("data:") ? qrCodeBase64 : `data:image/png;base64,${qrCodeBase64}`
 * Então `toPngBase64()` devolve um PNG de verdade (grayscale 8-bit, escrito
 * à mão com zlib nativo) e `toDataUrl()` devolve um data URL pronto.
 */
const zlib = require('zlib');
const qrcode = require('./vendor/qrcode-generator.js');

/* ------------------------------- PNG mínimo -------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** PNG grayscale 8-bit: 0 = preto (módulo escuro), 255 = branco. */
function encodePng(matrix, scale, margin) {
  const n = matrix.length;
  const size = (n + margin * 2) * scale;
  const stride = size + 1;
  const raw = Buffer.alloc(stride * size, 255);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filtro "none"
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && matrix[my][mx];
      raw[y * stride + 1 + x] = dark ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- API ------------------------------------- */

function matrix(text, ec = 'M') {
  const qr = qrcode(0, ec); // 0 = versão automática
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let r = 0; r < n; r++) {
    const row = new Array(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c);
    m.push(row);
  }
  return m;
}

const pngCache = new Map(); // payload -> base64 (o mesmo PIX é pedido várias vezes)

/** @returns {string} base64 de um PNG (sem prefixo) */
function toPngBase64(text, { scale = 4, margin = 8, ec = 'M' } = {}) {
  const key = `${text}|${scale}|${margin}|${ec}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const b64 = encodePng(matrix(text, ec), scale, margin).toString('base64');
  if (pngCache.size > 500) pngCache.clear();
  pngCache.set(key, b64);
  return b64;
}

/** @returns {string} data URL (data:image/png;base64,...) */
function toDataUrl(text, opts) {
  return `data:image/png;base64,${toPngBase64(text, opts)}`;
}

/** Compatibilidade com chamadas antigas que esperavam GIF. */
const toBase64 = toPngBase64;

module.exports = { toPngBase64, toDataUrl, toBase64, matrix };
