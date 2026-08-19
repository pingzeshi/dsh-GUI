#!/usr/bin/env node
/**
 * scripts/gen-art.js — DSH Desktop 美术资源生成器（零依赖，Node 内置 zlib）
 *
 * 输入：scripts/whale.svg（官方 DeepSeek 鲸鱼矢量，viewBox 0 0 50 50）
 * 输出：
 *   assets/icon.png          512×512 应用图标（浅色圆角方块 + 黑色鲸鱼，官方配色）
 *   assets/tray.png          16×16   托盘图标（品牌蓝鲸鱼，透明底）
 *   assets/tray-32.png       32×32   托盘图标（高 DPI 2x 表示）
 *   scripts/whale-points.json       开场页粒子鲸鱼目标点云（[x,y,edge] 单位坐标）
 *
 * 用法：node scripts/gen-art.js
 */
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// 1. 读取鲸鱼路径
// ---------------------------------------------------------------------------
const svg = fs.readFileSync(path.join(ROOT, 'scripts', 'whale.svg'), 'utf8')
const dm = svg.match(/d="([^"]+)"/)
if (!dm) throw new Error('whale.svg 中未找到 path d 属性')
const D = dm[1]

// ---------------------------------------------------------------------------
// 2. SVG path 解析（M/C/Z + 隐式 lineto 容错）→ 子路径（三次贝塞尔段数组）
// ---------------------------------------------------------------------------
function parsePath(d) {
  const tokens = d.match(/[MCZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []
  const subs = [] // 每个子路径：[[p0,c1,c2,p3], ...]
  let cur = null
  let px = 0, py = 0, sx = 0, sy = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'M') {
      px = parseFloat(tokens[++i]); py = parseFloat(tokens[++i])
      sx = px; sy = py
      cur = []; subs.push(cur)
    } else if (t === 'C') {
      const c1x = parseFloat(tokens[++i]), c1y = parseFloat(tokens[++i])
      const c2x = parseFloat(tokens[++i]), c2y = parseFloat(tokens[++i])
      const x = parseFloat(tokens[++i]), y = parseFloat(tokens[++i])
      cur.push([[px, py], [c1x, c1y], [c2x, c2y], [x, y]])
      px = x; py = y
    } else if (t === 'Z' || t === 'z') {
      if (cur.length) cur.push([[px, py], [px, py], [sx, sy], [sx, sy]])
      px = sx; py = sy
    } else {
      // 隐式 lineto（官方路径未用，容错）
      const x = parseFloat(t), y = parseFloat(tokens[++i])
      cur.push([[px, py], [px, py], [x, y], [x, y]])
      px = x; py = y
    }
  }
  return subs.filter((s) => s.length)
}

// ---------------------------------------------------------------------------
// 3. 三次贝塞尔自适应展平 → 多边形
// ---------------------------------------------------------------------------
function distToLine(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function flattenCubic(p0, c1, c2, p3, tol, out) {
  const d = Math.max(distToLine(c1, p0, p3), distToLine(c2, p0, p3))
  if (d <= tol) { out.push(p3); return }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const a = mid(p0, c1), b = mid(c1, c2), c = mid(c2, p3)
  const ab = mid(a, b), bc = mid(b, c)
  const m = mid(ab, bc)
  flattenCubic(p0, a, ab, m, tol, out)
  flattenCubic(m, bc, c, p3, tol, out)
}

/** 展平全部子路径为闭合多边形（单位坐标）。 */
function buildPolys(tol = 0.02) {
  const subs = parsePath(D)
  return subs.map((segments) => {
    const pts = [segments[0][0].slice()]
    for (const [p0, c1, c2, p3] of segments) flattenCubic(p0, c1, c2, p3, tol, pts)
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
    return pts
  })
}

// ---------------------------------------------------------------------------
// 4. 非零环绕扫描线光栅化（ss 倍超采样 → 覆盖率缓冲）
// ---------------------------------------------------------------------------
function buildEdges(polys, scale, ox, oy) {
  const edges = []
  for (const poly of polys) {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      const ay = a[1] * scale + oy, by = b[1] * scale + oy
      if (ay === by) continue
      const ax = a[0] * scale + ox, bx = b[0] * scale + ox
      let dir = 1, x1 = ax, y1 = ay, x2 = bx, y2 = by
      if (y1 > y2) { x1 = bx; y1 = by; x2 = ax; y2 = ay; dir = -1 }
      edges.push({ x1, y1, x2, y2, dx: x2 - x1, dy: y2 - y1, dir })
    }
  }
  return edges
}

/** 返回 W*H 的覆盖率 Float32Array（0..1）。 */
function fillCoverage(edges, W, H, ss) {
  const cov = new Float32Array(W * H)
  const inv = 1 / (ss * ss)
  const rows = H * ss, cols = W * ss
  for (let r = 0; r < rows; r++) {
    const y = r + 0.5
    const xs = []
    for (const e of edges) {
      if (y < e.y1 || y >= e.y2) continue
      xs.push([e.x1 + ((y - e.y1) * e.dx) / e.dy, e.dir])
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p[0] - q[0])
    let w = 0
    const py = (r / ss) | 0
    for (let k = 0; k < xs.length - 1; k++) {
      w += xs[k][1]
      if (w !== 0) {
        const c0 = Math.max(0, Math.floor(xs[k][0]))
        const c1 = Math.min(cols, Math.ceil(xs[k + 1][0]))
        for (let c = c0; c < c1; c++) cov[py * W + ((c / ss) | 0)] += inv
      }
    }
  }
  return cov
}

/** 点是否在鲸鱼内部（非零环绕，射线法）。 */
function pointInside(polys, px, py) {
  let w = 0
  for (const poly of polys) {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      const ay = a[1], by = b[1]
      if (ay === by) continue
      let dir = 1, y1 = ay, y2 = by, x1 = a[0], x2 = b[0]
      if (y1 > y2) { y1 = by; y2 = ay; x1 = b[0]; x2 = a[0]; dir = -1 }
      if (py >= y1 && py < y2) {
        const x = x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)
        if (x > px) w += dir
      }
    }
  }
  return w !== 0
}

// ---------------------------------------------------------------------------
// 5. 图像辅助：盒式模糊、圆形
// ---------------------------------------------------------------------------
function boxBlur(src, W, H, radius, passes) {
  let a = new Float32Array(src)
  let b = new Float32Array(src.length)
  for (let p = 0; p < passes; p++) {
    // 水平
    for (let y = 0; y < H; y++) {
      let acc = 0
      const row = y * W
      for (let x = -radius; x <= radius; x++) acc += a[row + Math.max(0, Math.min(W - 1, x))]
      for (let x = 0; x < W; x++) {
        b[row + x] = acc / (2 * radius + 1)
        const add = Math.min(W - 1, x + radius + 1), sub = Math.max(0, x - radius)
        acc += a[row + add] - a[row + sub]
      }
    }
    // 垂直
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let y = -radius; y <= radius; y++) acc += b[Math.max(0, Math.min(H - 1, y)) * W + x]
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / (2 * radius + 1)
        const add = Math.min(H - 1, y + radius + 1), sub = Math.max(0, y - radius)
        acc += b[add * W + x] - b[sub * W + x]
      }
    }
  }
  return a
}

// ---------------------------------------------------------------------------
// 6. PNG 编码（RGBA8，filter 0）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePNG(W, H, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------
// 7. 构图
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function whaleFit(polys, targetWidth) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const poly of polys) for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const scale = targetWidth / (maxX - minX)
  return {
    scale,
    ox: -(minX + (maxX - minX) / 2) * scale, // 居中偏移（构图时再加画布中心）
    oy: -(minY + (maxY - minY) / 2) * scale,
    w: (maxX - minX) * scale,
    h: (maxY - minY) * scale,
  }
}

/** 应用图标：官方黑色鲸鱼（透明底，无容器、无装饰）。 */
function renderIcon(size) {
  const polys = buildPolys()
  const fit = whaleFit(polys, size * 0.84)
  const ss = 4
  const cov = fillCoverage(
    buildEdges(polys, fit.scale * ss, (size / 2 + fit.ox) * ss, (size / 2 + fit.oy) * ss),
    size, size, ss,
  )
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const w = clamp01(cov[i])
    rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0
    rgba[o + 3] = Math.round(w * 255)
  }
  return encodePNG(size, size, rgba)
}

/** 托盘图标：透明底 + 品牌蓝鲸鱼 + 柔和蓝晕（暗/亮任务栏皆可读）。 */
function renderTray(size) {
  const polys = buildPolys()
  const fit = whaleFit(polys, size * 0.86)
  const ss = 4
  const cov = fillCoverage(buildEdges(polys, fit.scale * ss, (size / 2 + fit.ox) * ss, (size / 2 + fit.oy) * ss), size, size, ss)
  const glow = boxBlur(cov, size, size, Math.max(1, Math.round(size * 0.09)), 1)
  const rgba = Buffer.alloc(size * size * 4)
  const C = [91, 124, 255]   // #5B7CFF 品牌蓝
  const G = [124, 155, 255]  // 光晕浅蓝
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const w = clamp01(cov[i])
    const g = clamp01(glow[i]) * 0.38
    const r = w * C[0] + (1 - w) * G[0] * g
    const gg = w * C[1] + (1 - w) * G[1] * g
    const b = w * C[2] + (1 - w) * G[2] * g
    const a = Math.max(w, g * 0.55)
    rgba[o] = Math.round(r); rgba[o + 1] = Math.round(gg); rgba[o + 2] = Math.round(b)
    rgba[o + 3] = Math.round(a * 255)
  }
  return encodePNG(size, size, rgba)
}

// ---------------------------------------------------------------------------
// 8. 开场页粒子点云导出
// ---------------------------------------------------------------------------
function emitPoints() {
  const polys = buildPolys(0.05)
  const pts = []
  // 轮廓点：按弧长均匀采样
  for (const poly of polys) {
    const n = poly.length
    let L = 0
    for (let i = 0; i < n; i++) L += Math.hypot(poly[(i + 1) % n][0] - poly[i][0], poly[(i + 1) % n][1] - poly[i][1])
    const step = 0.30
    let acc = 0, j = 0
    for (let d = 0; d < L - 1e-6; d += step) {
      while (j < n - 1 && acc + Math.hypot(poly[j + 1][0] - poly[j][0], poly[j + 1][1] - poly[j][1]) < d) {
        acc += Math.hypot(poly[j + 1][0] - poly[j][0], poly[j + 1][1] - poly[j][1]); j++
      }
      const a = poly[j], b = poly[(j + 1) % n]
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const t = Math.min(1, (d - acc) / seg)
      pts.push([+(a[0] + (b[0] - a[0]) * t).toFixed(2), +(a[1] + (b[1] - a[1]) * t).toFixed(2), 1])
    }
  }
  // 内部点：网格采样（眼睛等孔洞由环绕数自动排除）
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const poly of polys) for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const step = 0.92
  for (let y = minY + step / 2; y <= maxY; y += step) {
    for (let x = minX + step / 2; x <= maxX; x += step) {
      if (pointInside(polys, x, y)) pts.push([+x.toFixed(2), +y.toFixed(2), 0])
    }
  }
  return pts
}

// ---------------------------------------------------------------------------
// 9. 主流程
// ---------------------------------------------------------------------------
function main() {
  const assets = path.join(ROOT, 'assets')
  fs.mkdirSync(assets, { recursive: true })

  const icon = renderIcon(512)
  fs.writeFileSync(path.join(assets, 'icon.png'), icon)

  const tray16 = renderTray(16)
  fs.writeFileSync(path.join(assets, 'tray.png'), tray16)

  const tray32 = renderTray(32)
  fs.writeFileSync(path.join(assets, 'tray-32.png'), tray32)

  const pts = emitPoints()
  fs.writeFileSync(path.join(ROOT, 'scripts', 'whale-points.json'), JSON.stringify(pts))

  console.log('[gen-art] assets/icon.png (512x512)     ' + icon.length + ' B')
  console.log('[gen-art] assets/tray.png (16x16)       ' + tray16.length + ' B')
  console.log('[gen-art] assets/tray-32.png (32x32)    ' + tray32.length + ' B')
  console.log('[gen-art] scripts/whale-points.json     ' + pts.length + ' points (' + pts.filter(p => p[2]).length + ' outline)')
}

main()
