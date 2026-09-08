import { test, expect } from "@playwright/test";
import jsQR from "jsqr";
import { qrMatrix, rsEncode } from "../src/qr.js";

/**
 * The QR encoder is verified against an INDEPENDENT decoder, not by eye.
 *
 * Both bugs it caught were invisible: a Reed-Solomon generator built with its
 * coefficients reversed (every codeword wrong, encoder still ran), and format
 * info written transposed (two asymmetric copies, so the result looked like a
 * QR and scanned as nothing). A handoff QR that resolves to the wrong URL would
 * hand a delegate someone else's mandate.
 */

function render(text: string) {
  const m = qrMatrix(text);
  const n = m.length, quiet = 4, scale = 4, size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!m[r]![c]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((r + quiet) * scale + dy) * size + ((c + quiet) * scale + dx)) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  return { data, size, modules: n };
}

test("reed-solomon matches the published 1-M vector", () => {
  const data = Uint8Array.from([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
  expect(Array.from(rsEncode(data, 10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

const CASES = [
  "HELLO",
  "https://leash-rho.vercel.app/app.html?role=delegate&m=42",
  "https://leash-rho.vercel.app/app.html?role=delegate&m=147&r=0x105e7732DE6D2E8C43e5803F8Df0D2d4860E7679",
  "a".repeat(120),
];

for (const text of CASES) {
  test(`round-trips ${text.length} bytes through an independent decoder`, () => {
    const { data, size } = render(text);
    const got = jsQR(data, size, size);
    expect(got, "decoder found no QR at all").not.toBeNull();
    expect(got!.data).toBe(text);
  });
}

test("refuses to silently truncate oversized input", () => {
  expect(() => qrMatrix("x".repeat(400))).toThrow(/does not fit/);
});
