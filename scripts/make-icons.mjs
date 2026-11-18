// 生成 PWA 图标（无需任何图像库）：蓝底圆角 + 白色 ¥ 符号
// 用法：node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../web');

const BLUE = [47, 111, 237];   // #2f6fed 主题色
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 每行前面加一个 filter 字节 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 画一条圆头线段（胶囊形）
function drawCapsule(buf, W, x1, y1, x2, y2, width, color) {
  const r = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1));
  const maxY = Math.min(W - 1, Math.ceil(Math.max(y1, y2) + r + 1));
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x - x1, py = y - y1;
      let t = (px * dx + py * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = x1 + t * dx, cy = y1 + t * dy;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        const i = (y * W + x) * 4;
        buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
      }
    }
  }
}

function makeIcon(size) {
  const S = 3;                  // 超采样倍数
  const W = size * S;
  const buf = Buffer.alloc(W * W * 4);   // 全透明
  const k = W / 512;                     // 以 512 为设计基准

  // 圆角矩形遮罩半径
  const radius = 116 * k;
  const inset = 0;
  const inRoundRect = (x, y) => {
    const left = inset, right = W - inset, top = inset, bottom = W - inset;
    if (x < left || x > right || y < top || y > bottom) return false;
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };

  // 背景
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (inRoundRect(x, y)) {
        const i = (y * W + x) * 4;
        buf[i] = BLUE[0]; buf[i + 1] = BLUE[1]; buf[i + 2] = BLUE[2]; buf[i + 3] = 255;
      }
    }
  }

  // 白色 ¥ 符号（设计坐标 512 基准）
  const P = (v) => v * k;
  const w = P(30);
  // V 形两笔（开口要宽、要扁，否则缩略图看起来像箭头）
  drawCapsule(buf, W, P(256), P(148), P(162), P(262), w, WHITE);
  drawCapsule(buf, W, P(256), P(148), P(350), P(262), w, WHITE);
  // 竖笔（从 V 汇合点往下）
  drawCapsule(buf, W, P(256), P(252), P(256), P(400), w, WHITE);
  // 两条横笔（压在竖笔下方区域）
  drawCapsule(buf, W, P(172), P(300), P(340), P(300), P(26), WHITE);
  drawCapsule(buf, W, P(172), P(356), P(340), P(356), P(26), WHITE);

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

for (const size of [192, 512]) {
  const png = makeIcon(size);
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`生成 ${file}（${(png.length / 1024).toFixed(1)} KB）`);
}
