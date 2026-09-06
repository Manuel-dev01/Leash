/**
 * Tolerate a flaky RPC without tolerating a wrong answer.
 *
 * A 50-minute measurement run died on ONE `eth_call` that timed out inside its
 * poll loop. The read was a progress check — "has it settled yet?" — and a
 * failed progress check is not a failed run. It threw, unwound badly, and lost
 * the point it had spent fifty minutes and twenty orders to get.
 *
 * Two different needs, deliberately two different functions, because conflating
 * them is how a retry loop starts hiding real failures:
 *
 *   withRetry  the operation MUST succeed. Retries, then throws. Use for writes
 *              and for reads whose value the caller is about to act on.
 *   poll       the operation is a progress check. Retries, then returns null,
 *              and the caller keeps waiting. Never invents a value — null means
 *              "did not read", which must not be confused with "read a zero".
 *
 * `poll` returning null rather than a default is the whole point. An earlier
 * version of this project reported "0 tradable markets" for what was actually
 * RPC rate-limiting, and the two were indistinguishable because the failure
 * path produced a plausible number.
 */

const firstLine = (e: unknown) =>
  ((e as Error)?.message ?? String(e)).split(String.fromCharCode(10))[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOpts {
  attempts?: number;
  /** First backoff in ms; doubles each attempt. */
  baseMs?: number;
  label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseMs ?? 2_000;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1) break;
      const wait = base * 2 ** i;
      console.error(`  [retry] ${opts.label ?? "call"} failed (${firstLine(e)}), attempt ${i + 1}/${attempts}, waiting ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`${opts.label ?? "call"} failed after ${attempts} attempts: ${firstLine(last)}`);
}

/**
 * A progress check that is allowed to fail. Returns null when it could not
 * read, so the caller can keep waiting instead of dying — and can tell the
 * difference between "not read" and "read, and it is zero".
 */
export async function poll<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T | null> {
  try {
    return await withRetry(fn, { attempts: opts.attempts ?? 3, baseMs: opts.baseMs ?? 1_500, label: opts.label });
  } catch (e) {
    console.error(`  [poll] ${opts.label ?? "check"} unavailable this tick: ${firstLine(e)}`);
    return null;
  }
}
