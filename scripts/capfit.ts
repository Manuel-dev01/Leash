/**
 * The batch cap, computed in ONE place.
 *
 * It used to be computed in two: `stage3-live.ts` set it after a measurement
 * run, and `verify.ts` asserted it. They disagreed — stage3 reserved "5/6 of
 * the limit" as a working budget, an arbitrary figure with no derivation, while
 * verify used the measured wrapper overhead. So a measurement run would set 13
 * and the next verify would fail demanding 15, and the on-chain value silently
 * depended on which script ran last.
 *
 * That is not a bug in either formula. It is a bug in there being two.
 */

export interface Point {
  n: number;
  gas: number;
  marketId: string;
  tx: string;
  codeHash: string;
  at: string;
  subGasLimit: string;
  /**
   * The first settle a handler ever performs writes its counters
   * zero->nonzero (20,000 gas instead of 5,000). Tagged rather than discarded,
   * so the fit can exclude it and the exclusion is visible.
   */
  firstEver: boolean;
}

/**
 * The gasLimit the subscription is ARMED with. Forced by measurement: a
 * 12-mandate settle costs 3,301,786 gas in-body, so under the 3,000,000 this
 * once used the demo's own headline batch runs out of gas and settles nothing.
 * Charging is on gas USED, not gasLimit, so the wider limit is free.
 */
export const SHIP_GAS_LIMIT = 8_000_000;

/**
 * Receipt gasUsed minus the Deadhand event's in-body figure. MEASURED at
 * 107,556 gas on all three settles — n=3, n=12 and n=32 — identical to the gas,
 * which is what a fixed wrapper should look like. It is the precompile
 * dispatch, the onEvent wrapper and intrinsic cost, and the batch has to leave
 * room for it because the gasLimit applies to the whole invocation while the
 * fit is in-body.
 */
export const WRAPPER_OVERHEAD = 107_556;

/** In-body gas a batch may use before the invocation exceeds its limit. */
export const WORKING_BUDGET = SHIP_GAS_LIMIT - WRAPPER_OVERHEAD;

/**
 * Deliberate, and not timidity. An invocation that runs out of gas settles
 * NOTHING and reports no error anyone sees. This covers fit error — the
 * two-point fit under-predicted the real n=32 cost by 5.8% — and mandates that
 * cost more than the ones measured: a revoked mandate writes an extra event and
 * slot, a failed transfer books a claim.
 */
export const HEADROOM = 0.5;

/** Ordinary least squares. Returns null when the points do not define a line. */
export function fit(points: Point[]): { fixed: number; marginal: number } | null {
  if (new Set(points.map((p) => p.n)).size < 2) return null;
  const k = points.length;
  const sx = points.reduce((a, p) => a + p.n, 0);
  const sy = points.reduce((a, p) => a + p.gas, 0);
  const sxx = points.reduce((a, p) => a + p.n * p.n, 0);
  const sxy = points.reduce((a, p) => a + p.n * p.gas, 0);
  const denom = k * sxx - sx * sx;
  if (denom === 0) return null;
  const marginal = (k * sxy - sx * sy) / denom;
  return { marginal, fixed: (sy - marginal * sx) / k };
}

/**
 * Which points the fit should use: warm ones if they alone define a line,
 * otherwise all of them, and the caller is told which happened.
 */
export function choosePoints(all: Point[]): { used: Point[]; excludedFirstEver: boolean } {
  const warm = all.filter((p) => !p.firstEver);
  if (fit(warm)) return { used: warm, excludedFirstEver: warm.length < all.length };
  return { used: all, excludedFirstEver: false };
}

export interface Cap {
  fixed: number;
  marginal: number;
  /** Batch size at which the working budget is exhausted. */
  binds: number;
  /** What to ship: `binds` at HEADROOM. */
  cap: number;
  /** Total gas a full batch at `cap` charges, wrapper included. */
  charges: number;
  usedPoints: number;
  excludedFirstEver: boolean;
}

/** The whole computation, from points to the number that goes on chain. */
export function capFrom(all: Point[]): Cap | null {
  const { used, excludedFirstEver } = choosePoints(all);
  const line = fit(used);
  if (!line) return null;
  const binds = Math.floor((WORKING_BUDGET - line.fixed) / line.marginal);
  const cap = Math.floor(binds * HEADROOM);
  return {
    ...line,
    binds,
    cap,
    charges: Math.round(line.fixed + line.marginal * cap + WRAPPER_OVERHEAD),
    usedPoints: used.length,
    excludedFirstEver,
  };
}
