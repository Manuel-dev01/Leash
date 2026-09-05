/**
 * App state and the screen model, mirroring the design's own `role`/`screen`
 * shape so the two stay comparable.
 */
import type { Address, Hex } from "viem";

export type Role = "delegator" | "delegate";
export type Screen =
  | "connect" | "pick" | "limits" | "review" | "monitor" | "revoke"
  | "trade" | "market" | "positions";

export interface Market {
  marketId: Hex;
  pool: Address;
  asset: string;
  expiry: bigint;
  label: string;
}

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
  allowed: Set<string>;
  /** The mandate being monitored / traded. */
  mandateId: bigint | null;
  activeMarket: number;
  side: "up" | "down";
  size: number;
  busy: boolean;
  error: string;
  log: { html: string }[];
  /**
   * When the mandate figures on screen were last read from the contract, and
   * whether the allowed-market set has been checked against it.
   *
   * These exist because the monitor screen says "every figure above is read
   * from the contract" — a claim that was false whenever a poll failed, since
   * the failure was swallowed and the previous read stayed on screen with
   * nothing marking it as old. A limit displayed without having been checked is
   * the exact thing this app is not allowed to do.
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
  allowed: new Set(),
  mandateId: null,
  activeMarket: 0,
  side: "up",
  size: 25,
  busy: false,
  error: "",
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
 * The design's own rationale for each screen, kept because it records intent the
 * markup cannot.
 */
export const WHY: Record<Screen, string> = {
  connect: "the first screen sells the mechanism, not the brand. a delegator who does not understand that nothing is being sent will not sign.",
  pick: "the delegate is named before the limits are set, so the limits are chosen for a person rather than in the abstract.",
  limits: "four limits, each with the sentence that says what it prevents. nothing hidden behind an advanced toggle.",
  review: "the signature screen states what is being signed in plain terms and names the withdraw destination, which is the question a careful delegator actually has.",
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
    ["05", "monitor", "monitor"],
    ["06", "revoke", "revoke"],
  ],
  delegate: [
    ["01", "place_order", "trade"],
    ["02", "market_detail", "market"],
    ["03", "open_positions", "positions"],
  ],
};
