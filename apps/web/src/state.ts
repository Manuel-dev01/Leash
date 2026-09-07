/**
 * App state and the screen model, mirroring the design's own `role`/`screen`
 * shape so the two stay comparable.
 */
import type { Address, Hex } from "viem";

export type Role = "delegator" | "delegate";
export type Screen =
  | "connect" | "pick" | "limits" | "review" | "issue" | "monitor" | "revoke"
  | "trade" | "market" | "positions";

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
  screen: "connect",
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
 * The design's own rationale for each screen, kept because it records intent the
 * markup cannot.
 */
export const WHY: Record<Screen, string> = {
  connect: "the first screen sells the mechanism, not the brand. a delegator who does not understand that nothing is being sent will not sign.",
  pick: "the delegate is named before the limits are set, so the limits are chosen for a person rather than in the abstract.",
  limits: "four limits, each with the sentence that says what it prevents. nothing hidden behind an advanced toggle.",
  review: "the signature screen states what is being signed in plain terms and names the withdraw destination, which is the question a careful delegator actually has.",
  issue: "the handoff is the one step that crosses two people and two devices. it has to work with a phone camera and no typing.",
  monitor: "the delegator reads the delegation without asking the delegate anything.",
  revoke: "revoke reads as one transaction with no counterparty, and the held-by-registry line is the proof, sitting at zero.",
  trade: "the limits sit above the ticket permanently. the delegate cannot look at a market without seeing the envelope they are working inside.",
  market: "their own fills are marked, and the allowed line ties the market back to the delegator list.",
  positions: "positions are shown to the delegate but labelled as settling to the delegator, so ownership is never ambiguous mid-trade.",
};

export const NAV: Record<Role, [string, string, Screen][]> = {
  delegator: [
    ["01", "connect", "connect"],
    ["02", "choose_delegate", "pick"],
    ["03", "set_limits", "limits"],
    ["04", "review_sign", "review"],
    ["05", "issue", "issue"],
    ["06", "monitor", "monitor"],
    ["07", "revoke", "revoke"],
  ],
  delegate: [
    ["01", "place_order", "trade"],
    ["02", "market_detail", "market"],
    ["03", "open_positions", "positions"],
  ],
};
