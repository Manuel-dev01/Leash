import { test, expect } from "@playwright/test";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { errName } from "../src/chain.js";

/**
 * `errName` names the limit that stopped an order, and the delegate screen
 * turns that name into a sentence: "refused — bigger than the per-order cap."
 * So a wrong name is not a cosmetic bug, it is the product asserting something
 * false about what the contract said.
 *
 * The original implementation JSON-stringified the whole error and searched the
 * text for each error name in turn. viem attaches the ABI to its errors, so
 * every name was present in every contract error, and the first one checked —
 * `NotDelegator` — was returned for everything, including a user rejecting in
 * their wallet. Every refusal message on the delegate screen was unreachable.
 */

test("does not read an error name out of the ABI attached to the error", () => {
  // The exact shape that defeated the old matcher: the names appear, but only
  // as part of the ABI carried along for decoding — nothing reverted.
  const looksLikeItMentionsEverything = {
    code: 4001,
    message: "User rejected the request.",
    abi: [
      { type: "error", name: "NotDelegator", inputs: [] },
      { type: "error", name: "MarketNotAllowed", inputs: [] },
      { type: "error", name: "ExceedsCumulative", inputs: [] },
    ],
  };
  const out = errName(looksLikeItMentionsEverything);
  expect(out).not.toBe("NotDelegator");
  expect(out).not.toBe("MarketNotAllowed");
  expect(out).toMatch(/rejected/i);
});

test("names a real revert by the error the contract actually raised", () => {
  const reverted = new ContractFunctionRevertedError({
    abi: [
      { type: "error", name: "NotDelegator", inputs: [] },
      { type: "error", name: "StakeExceedsPerTrade", inputs: [
        { name: "cost", type: "uint256" }, { name: "limit", type: "uint128" },
      ] },
    ],
    data: "0x",
    functionName: "placeForDelegator",
  });
  // Hand it the decoded result directly: what matters is that errName reports
  // the error that was raised, not the first one it can find in the ABI.
  (reverted as unknown as { data: { errorName: string } }).data = {
    errorName: "StakeExceedsPerTrade",
  };
  const wrapped = new BaseError("call reverted", { cause: reverted });
  expect(errName(wrapped)).toBe("StakeExceedsPerTrade");
});

test("reports a wallet rejection as a rejection, not as a limit", () => {
  const wrapped = new BaseError("user refused", {
    cause: new UserRejectedRequestError(new Error("User rejected the request.")),
  });
  const out = errName(wrapped);
  expect(out).toMatch(/rejected/i);
  // The failure that reached production: a decline in the wallet, reported as
  // a mandate violation the contract never raised.
  expect(out).not.toMatch(/NotDelegator|ExceedsCumulative|MarketNotAllowed/);
});

test("falls back to a readable first line, never an empty string", () => {
  expect(errName(new Error("boom\nstack line\nanother"))).toBe("boom");
  expect(errName({})).toBe("Transaction failed");
  expect(errName(undefined)).toBe("Transaction failed");
});
