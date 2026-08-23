import { keccak256, toHex } from "viem";
import { SIGNATURES, TOPICS } from "./constants.js";

/**
 * Reconciles pinned topic0 constants against values derived from their
 * signatures, at boot.
 *
 * Two pieces of guidance disagree, and the disagreement is the whole point:
 *
 *   CLAUDE.md §4.2 r11 : "never hardcode topics, resolve at boot"
 *   Bot Kit gotchas #10: "pin topic0 from the docs, don't hand-roll it"
 *
 * Neither alone is safe. What actually broke people was deriving a topic from a
 * signature string that had silently changed (OrderFilled gained `fillPrice`);
 * their listener stopped matching and said nothing. But pinning alone means a
 * future change is equally silent — the constant just stops corresponding to
 * reality.
 *
 * So we do both and require agreement. If a signature ever changes under us,
 * this throws at startup instead of a listener quietly matching nothing. A
 * subscription that silently stops matching is the failure mode that kills the
 * demo, because it looks exactly like "no events happened yet".
 */

export type TopicName = keyof typeof SIGNATURES;

export function deriveTopic0(signature: string): `0x${string}` {
  return keccak256(toHex(signature));
}

export interface TopicCheck {
  name: TopicName;
  signature: string;
  pinned: string;
  derived: string;
  ok: boolean;
}

/** Check every topic we depend on. Pure — callers decide how loud to be. */
export function checkTopics(): TopicCheck[] {
  return (Object.keys(SIGNATURES) as TopicName[]).map((name) => {
    const signature = SIGNATURES[name];
    const derived = deriveTopic0(signature);
    const pinned = TOPICS[name as keyof typeof TOPICS] as string;
    return { name, signature, pinned, derived, ok: pinned === derived };
  });
}

/**
 * Throw unless every pinned topic matches its derived value. Call this at the
 * top of every entry point that reads logs — the doctor, the subscription
 * registrar, and any script that decodes a receipt.
 */
export function assertTopicsMatch(): void {
  const bad = checkTopics().filter((c) => !c.ok);
  if (bad.length === 0) return;
  const detail = bad
    .map(
      (c) =>
        `  ${c.name}\n    signature : ${c.signature}\n    pinned    : ${c.pinned}\n    derived   : ${c.derived}`,
    )
    .join("\n");
  throw new Error(
    `Topic mismatch — a contract signature changed under us (${bad.length} of ${
      checkTopics().length
    }):\n${detail}\n\n` +
      "Do NOT paper over this by trusting the derived value. Re-read the event " +
      "from a live receipt, confirm the new shape, then update constants.ts " +
      "together with its provenance note.",
  );
}
