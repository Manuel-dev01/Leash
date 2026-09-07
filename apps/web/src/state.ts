/**
 * App state and the screen model, mirroring the design's own `role`/`screen`
 * shape so the two stay comparable.
 */
import type { Address, Hex } from "viem";

export type Role = "delegator" | "delegate";
/**
 * The delegator's flow is not seven equal steps. It is a SETUP you do once and
 * a SURFACE you come back to, and flattening those into one numbered list is
 * what made the app read like a form rather than a product.
 *
 *   setup -> limits -> review -> issue     four steps, strictly ordered
 *   manage                                  where you live afterwards
 *
 * The delegate gets ONE screen. Someone scanning a QR on a phone should meet a
 * ticket, not an information architecture.
 */
export type Screen =
  | "setup" | "limits" | "review" | "issue" | "manage"
  | "trade";

/** The ordered setup steps, for the progress indicator. */
export const SETUP_STEPS: { screen: Screen; label: string }[] = [
  { screen: "setup", label: "who trades" },
  { screen: "limits", label: "the limits" },
  { screen: "review", label: "review" },
  { screen: "issue", label: "hand over" },
];

export interface Market {
  marketId: Hex;
  pool: Address;
  asset: string;
  expiry: bigint;
  label: string;
}

/**
 * Discovery has FOUR outcomes and they must not share a rendering.
 *
 * "loading", "empty" and "failed" all used to display the same string —
 * `reading live markets from chain…` — forever, so a quiet venue, a broken RPC
 * and a request still in flight were indistinguishable. That is the exact
 * confusion `discover.ts` was written to prevent, leaking back in at the render
 * layer.
 */
export type MarketsState = "loading" | "ok" | "empty" | "failed";

export interface State {
  role: Role;
  screen: Screen;
  account: Address | null;
  onChain: boolean;
  /** Draft mandate, delegator side. Human units; converted at submit. */
  delegate: string;
  budget: number;
  maxOrder: number;
  days: number;
  markets: Market[];
  marketsState: MarketsState;
  /** Why discovery failed, when it did. Empty otherwise. */
  marketsError: string;
  allowed: Set<string>;
  /** The mandate being monitored / traded. */
  mandateId: bigint | null;
  /** Set when `?m=` was present but unusable, so the app can say so. */
  mandateParamError: string;
  activeMarket: number;
  side: "up" | "down";
  size: number;
  busy: boolean;
  /** A failure. Rendered in the accent colour. */
  error: string;
  /**
   * Something worth knowing that is NOT a failure. Kept apart from `error`
   * because rendering "3 markets live, 1 check failed" in the same alarm red as
   * a reverted transaction trains people to ignore both.
   */
  notice: string;
  log: { html: string }[];
  /**
   * When the on-screen mandate figures were last read from the contract, and
   * whether the allowed-market set has been checked against it.
   *
   * These exist because the monitor screen says the figures come from the
   * contract — a claim that was false whenever a poll failed, since the failure
   * was swallowed and the previous read stayed on screen with nothing marking
   * it as old.
   */
  chainAt: number;
  allowedKnown: boolean;
}

/** Three poll intervals. Past this, say so rather than implying freshness. */
export const STALE_MS = 25_000;

export function staleness(now = Date.now()): { known: boolean; stale: boolean; ageS: number } {
  if (state.chainAt === 0) return { known: false, stale: true, ageS: 0 };
  const ageS = Math.round((now - state.chainAt) / 1000);
  return { known: true, stale: now - state.chainAt > STALE_MS, ageS };
}

export const state: State = {
  role: "delegator",
  screen: "setup",
  account: null,
  onChain: false,
  delegate: "",
  budget: 500,
  maxOrder: 50,
  days: 7,
  markets: [],
  marketsState: "loading",
  marketsError: "",
  allowed: new Set(),
  mandateId: null,
  mandateParamError: "",
  activeMarket: 0,
  side: "up",
  size: 25,
  busy: false,
  error: "",
  notice: "",
  log: [],
  chainAt: 0,
  allowedKnown: false,
};

type Listener = () => void;
const listeners: Listener[] = [];
export const subscribe = (fn: Listener) => { listeners.push(fn); };
export function set(patch: Partial<State>) {
  Object.assign(state, patch);
  for (const fn of listeners) fn();
}

/**
 * Move to another screen and drop whatever was transient.
 *
 * `error`, `notice` and `busy` are per-attempt, not per-session. Leaving them
 * behind put "that is not a 20-byte address" under the revoke copy, and left a
 * hung signature disabling buttons on screens that had nothing to do with it.
 */
export function go(screen: Screen) {
  set({ screen, error: "", notice: "", busy: false });
}

/**
 * NOTE: the design file's `why_this_screen` notes used to be rendered into the
 * page. They are rationale ABOUT the design, addressed to whoever reads it —
 * "the first screen sells the mechanism, not the brand" is a note to a
 * designer, and it was showing to users on every screen. The notes now live
 * where they belong: as comments above the screens they describe.
 */
/** Where each role starts. */
export const HOME: Record<Role, Screen> = { delegator: "setup", delegate: "trade" };

/** How far through setup we are, or null once setup is done. */
export function stepOf(screen: Screen): { index: number; total: number; label: string } | null {
  const i = SETUP_STEPS.findIndex((s) => s.screen === screen);
  if (i < 0) return null;
  return { index: i + 1, total: SETUP_STEPS.length, label: SETUP_STEPS[i]!.label };
}
