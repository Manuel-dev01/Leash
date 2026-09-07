/**
 * A QR encoder, byte mode, versions 1–10, error correction level M.
 *
 * Self-contained on purpose. The handoff is the one step of this product that
 * happens between two people and two devices, so it must not depend on a CDN
 * being reachable at the moment someone is standing there with a phone.
 *
 * It is verified rather than eyeballed: `apps/web/tests/qr.spec.ts` renders the
 * output and decodes it with an independent library, asserting it round-trips
 * to the exact string. A QR that "looks like a QR" and scans to the wrong URL
 * would hand a delegate someone else's mandate.
 */

// ---- GF(256) arithmetic for Reed-Solomon ---------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR generator polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/**
 * Product of (x - a^i) for i in 0..degree-1, with the LEADING coefficient at
 * index 0 — which is the order `rsEncode` divides in.
 *
 * Getting this backwards is silent: the polynomial is still valid, the encoder
 * still runs, and every codeword it produces is wrong. It cost a round of
 * debugging and was only caught by checking against a published vector, which
 * is why that check is now a test rather than a one-off.
 */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i]! ^= poly[i]!;                    // poly * x
      next[i + 1]! ^= mul(poly[i]!, EXP[d]!);  // poly * a^d
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j]! ^= mul(gen[j]!, factor);
  }
  return res.slice(data.length);
}

// ---- capacity tables, level M, versions 1..10 -----------------------------
// [ total codewords, ec codewords per block, group1 blocks, group2 blocks ]
const M_SPEC: Record<number, [number, number, number, number]> = {
  1: [26, 10, 1, 0],
  2: [44, 16, 1, 0],
  3: [70, 26, 1, 0],
  4: [100, 18, 2, 0],
  5: [134, 24, 2, 0],
  6: [172, 16, 4, 0],
  7: [196, 18, 4, 0],
  8: [242, 22, 2, 2],
  9: [292, 22, 3, 2],
  10: [346, 26, 4, 1],
};

const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCodewords = (v: number) => {
  const [total, ec, g1, g2] = M_SPEC[v]!;
  return total - ec * (g1 + g2);
};

// ---- bit buffer -----------------------------------------------------------

class Bits {
  bytes: number[] = [];
  private len = 0;
  push(value: number, width: number) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      const idx = this.len >>> 3;
      if (this.bytes.length <= idx) this.bytes.push(0);
      if (bit) this.bytes[idx] = this.bytes[idx]! | (0x80 >>> (this.len & 7));
      this.len++;
    }
  }
  get length() { return this.len; }
}

// ---- the matrix -----------------------------------------------------------

type Grid = (0 | 1 | null)[][];

function place(v: number, codewords: Uint8Array): Grid {
  const n = v * 4 + 17;
  const g: Grid = Array.from({ length: n }, () => Array<0 | 1 | null>(n).fill(null));

  const finder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        g[rr]![cc] = on ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  // timing patterns
  for (let i = 8; i < n - 8; i++) {
    const on: 0 | 1 = i % 2 === 0 ? 1 : 0;
    if (g[6]![i] === null) g[6]![i] = on;
    if (g[i]![6] === null) g[i]![6] = on;
  }

  // alignment patterns
  const centres = ALIGN[v]!;
  for (const r of centres) {
    for (const c of centres) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          g[r + dr]![c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  g[n - 8]![8] = 1; // the always-dark module

  // reserve format areas so data placement skips them
  const reserve = (r: number, c: number) => { if (g[r]![c] === null) g[r]![c] = 0; };
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, n - 1 - i); reserve(n - 1 - i, 8); }
  if (v >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserve(i, n - 11 + j); reserve(n - 11 + j, i); }
  }

  // zig-zag data placement
  let bit = 0;
  const total = codewords.length * 8;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < n; i++) {
      const row = up ? n - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (g[row]![c] !== null) continue;
        let val: 0 | 1 = 0;
        if (bit < total) {
          val = ((codewords[bit >>> 3]! >>> (7 - (bit & 7))) & 1) as 0 | 1;
          bit++;
        }
        g[row]![c] = val;
      }
    }
    up = !up;
  }
  return g;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Which modules are structural (must never be masked). */
function functionMask(v: number): boolean[][] {
  const n = v * 4 + 17;
  const f = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const box = (r: number, c: number, h: number, w: number) => {
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const rr = r + i, cc = c + j;
      if (rr >= 0 && cc >= 0 && rr < n && cc < n) f[rr]![cc] = true;
    }
  };
  box(0, 0, 9, 9); box(0, n - 8, 9, 8); box(n - 8, 0, 8, 9);
  for (let i = 0; i < n; i++) { f[6]![i] = true; f[i]![6] = true; }
  const centres = ALIGN[v]!;
  for (const r of centres) for (const c of centres) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
    box(r - 2, c - 2, 5, 5);
  }
  if (v >= 7) { box(0, n - 11, 6, 3); box(n - 11, 0, 3, 6); }
  return f;
}

function penalty(g: Grid): number {
  const n = g.length;
  let score = 0;
  const at = (r: number, c: number) => (g[r]![c] ? 1 : 0);
  // rule 1: runs of five or more
  for (let r = 0; r < n; r++) {
    for (const horiz of [true, false]) {
      let run = 1;
      for (let i = 1; i < n; i++) {
        const a = horiz ? at(r, i) : at(i, r);
        const b = horiz ? at(r, i - 1) : at(i - 1, r);
        if (a === b) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const s = at(r, c) + at(r, c + 1) + at(r + 1, c) + at(r + 1, c + 1);
    if (s === 0 || s === 4) score += 3;
  }
  // rule 3: finder-like patterns
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const rpat = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) for (let c = 0; c + 11 <= n; c++) {
    let h1 = true, h2 = true, v1 = true, v2 = true;
    for (let i = 0; i < 11; i++) {
      if (at(r, c + i) !== pat[i]) h1 = false;
      if (at(r, c + i) !== rpat[i]) h2 = false;
      if (at(c + i, r) !== pat[i]) v1 = false;
      if (at(c + i, r) !== rpat[i]) v2 = false;
    }
    if (h1) score += 40; if (h2) score += 40; if (v1) score += 40; if (v2) score += 40;
  }
  // rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += at(r, c);
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

const FORMAT_GEN = 0x537;
function formatBits(maskId: number): number {
  // level M is 0b00
  let data = (0b00 << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * FORMAT_GEN);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionBits(v: number): number {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return (v << 12) | rem;
}

/**
 * Encode `text` and return a square matrix of 0/1 modules.
 * Throws when the text does not fit in version 10 at level M (~271 bytes).
 */
export function qrMatrix(text: string, forceMask?: number): (0 | 1)[][] {
  const utf8 = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const lenBits = v <= 9 ? 8 : 16;
    const need = 4 + lenBits + utf8.length * 8;
    if (need <= dataCodewords(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error(`qr: ${utf8.length} bytes does not fit version 10 at level M`);

  const lenBits = version <= 9 ? 8 : 16;
  const cap = dataCodewords(version);
  const bits = new Bits();
  bits.push(0b0100, 4);              // byte mode
  bits.push(utf8.length, lenBits);
  for (const b of utf8) bits.push(b, 8);
  const terminator = Math.min(4, cap * 8 - bits.length);
  if (terminator > 0) bits.push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0, 1);
  const data = bits.bytes.slice();
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < cap; i++) data.push(PAD[i % 2]!);

  // split into blocks, interleave data then ec
  const [, ecLen, g1, g2] = M_SPEC[version]!;
  const blocks = g1 + g2;
  const shortLen = Math.floor(cap / blocks);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const len = i < g1 ? shortLen : shortLen + 1;
    const blk = Uint8Array.from(data.slice(off, off + len));
    off += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecLen));
  }
  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]!);

  const raw = place(version, Uint8Array.from(out));
  const fn = functionMask(version);
  const n = raw.length;

  // choose the mask with the lowest penalty
  let best: (0 | 1)[][] | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let m = forceMask ?? 0; m < (forceMask !== undefined ? forceMask + 1 : 8); m++) {
    const g: (0 | 1)[][] = raw.map((row, r) =>
      row.map((val, c) => (fn[r]![c] ? (val ?? 0) : (((val ?? 0) ^ (MASKS[m]!(r, c) ? 1 : 0)) as 0 | 1))),
    );
    applyFormat(g, m, version);
    const s = penalty(g);
    if (s < bestScore) { bestScore = s; best = g; bestMask = m; }
  }
  void bestMask;
  return best!;
}

function applyFormat(g: (0 | 1)[][], maskId: number, v: number) {
  const n = g.length;
  const f = formatBits(maskId);
  const bit = (i: number): 0 | 1 => (((f >>> i) & 1) as 0 | 1);
  // The two copies are ASYMMETRIC — the first runs down column 8 then left
  // along row 8, the second runs left along row 8 then down column 8. Writing
  // them transposed produces a plausible-looking code that no scanner reads,
  // which is exactly what happened.
  for (let i = 0; i <= 5; i++) g[i]![8] = bit(i);
  g[7]![8] = bit(6);
  g[8]![8] = bit(7);
  g[8]![7] = bit(8);
  for (let i = 9; i <= 14; i++) g[8]![14 - i] = bit(i);

  for (let i = 0; i <= 7; i++) g[8]![n - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) g[n - 15 + i]![8] = bit(i);
  g[n - 8]![8] = 1; // always dark, never a format bit
  if (v >= 7) {
    const vb = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const b = ((vb >>> i) & 1) as 0 | 1;
      const r = Math.floor(i / 3), c = (i % 3) + n - 11;
      g[r]![c] = b;
      g[c]![r] = b;
    }
  }
}

/** The matrix as an inline SVG string, with a quiet zone. */
export function qrSvg(text: string, px = 220): string {
  const m = qrMatrix(text);
  const n = m.length;
  const quiet = 4;
  const size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r]![c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code for the delegate link">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${d}" fill="#000000"/></svg>`
  );
}
