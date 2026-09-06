/**
 * Subscription unwind for the failure path.
 *
 * A crash in a polling loop once left a subscription armed and unattended. It
 * burned ~0.19 STT across 400 invocations before anyone noticed — cheap that
 * time, because someone was watching. The same bug during the freeze window, or
 * overnight, is not.
 *
 * So: any script that ARMS a subscription installs this. It runs on an
 * unhandled failure, an unhandled rejection, and Ctrl-C, and it says loudly
 * when it could not unwind, because a silent failure here is the expensive kind.
 *
 * Three properties this file has to have, each because its absence is a way to
 * lose money quietly:
 *
 *   IDEMPOTENT   safe to call when nothing is armed, so a caller that has lost
 *                track of the state can still call it.
 *   LOUD         never returns quietly on a missing key or a failed cancel. A
 *                function that can "succeed" without reaching the chain is a
 *                status line that prints without checking anything.
 *   CHECKABLE    `stillArmed()` reads the chain, so the caller asserts the
 *                outcome instead of assuming the attempt worked.
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";

const chain = {
  id: NETWORK.chainId,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const abi = parseAbi([
  "function unsubscribeNow()",
  "function subscriptionId() view returns (uint256)",
]);

const firstLine = (e: unknown) =>
  ((e as Error)?.message ?? String(e)).split(String.fromCharCode(10))[0];

/**
 * Which handler this process armed. `probe-c.ts` arms a ProbeHandler, not the
 * Deadhand one, and defaulting to DEADHAND_HANDLER would have unwound the wrong
 * contract while leaving the armed one running — a cleanup that reports success
 * and cleans nothing.
 */
let target: string | undefined;
export function setUnwindTarget(addr: string): void { target = addr; }
const handlerAddr = () => target ?? process.env.DEADHAND_HANDLER;

/**
 * Is a subscription live right now? Read from chain, never inferred from
 * whether the unsubscribe call appeared to work.
 *
 * Throws rather than returning false when it cannot tell. "I could not check"
 * and "nothing is armed" must not be the same return value — that equivalence
 * is what let a crashed run look clean.
 */
export async function stillArmed(): Promise<boolean> {
  const handler = handlerAddr();
  if (!handler) throw new Error("stillArmed: no unwind target (DEADHAND_HANDLER unset and setUnwindTarget not called)");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const id = (await pub.readContract({
    address: handler as Address, abi, functionName: "subscriptionId",
  })) as bigint;
  return id !== 0n;
}

export async function emergencyUnsubscribe(): Promise<void> {
  const key = process.env.FUND_KEY;
  const handler = handlerAddr();
  if (!key || !handler) {
    console.error(
      "  [unwind] CANNOT UNWIND: FUND_KEY missing, or no handler target set.",
      "If a subscription was armed, it is still armed. Cancel it by hand.",
    );
    return;
  }
  try {
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const id = (await pub.readContract({
      address: handler as Address, abi, functionName: "subscriptionId",
    })) as bigint;
    if (id === 0n) return; // nothing armed; unsubscribeNow is a no-op anyway
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    const w = createWalletClient({ account, chain, transport: http(RPC) });
    const hash = await w.writeContract({ address: handler as Address, abi, functionName: "unsubscribeNow" });
    const r = await pub.waitForTransactionReceipt({ hash });
    // A mined transaction is not a cancelled subscription. Read it back.
    const after = (await pub.readContract({
      address: handler as Address, abi, functionName: "subscriptionId",
    })) as bigint;
    if (after === 0n) {
      console.error(`  [unwind] subscription ${id} cancelled after failure (${r.status})`);
    } else {
      console.error(
        `  [unwind] STILL ARMED after an apparently successful unsubscribe on ${handler}`,
        `— subscriptionId is ${after}. Cancel it by hand NOW.`,
      );
    }
  } catch (e) {
    // Loud: an un-unwound subscription silently spends money for as long as it
    // takes someone to notice.
    console.error(
      `  [unwind] COULD NOT CANCEL the subscription on ${handler} — cancel it by hand NOW.`,
      firstLine(e),
    );
  }
}

/**
 * Unwind, and keep trying.
 *
 * One attempt is not enough, and the reason is structural rather than bad luck:
 * the thing that makes a run fail is usually the RPC, and the RPC is what the
 * unwind needs. A measurement run died on an `eth_call` timeout, and the single
 * unwind attempt hit the same unresponsive endpoint and gave up — leaving the
 * subscription armed and spending, which is precisely the outcome the whole
 * unwind path exists to prevent.
 */
export async function unwindPersistently(attempts = 6): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await emergencyUnsubscribe();
    try {
      if (!(await stillArmed())) return true;
    } catch { /* could not even check; treat as still armed and keep trying */ }
    const wait = 3_000 * 2 ** i;
    console.error(`  [unwind] still armed after attempt ${i + 1}/${attempts}, retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.error(`  [unwind] GIVING UP after ${attempts} attempts. THE SUBSCRIPTION IS STILL ARMED and is spending on every finalization. Cancel it by hand.`);
  return false;
}

let installed = false;

/**
 * Install on a script that arms a subscription. Covers Ctrl-C, a kill, a throw
 * that escapes every handler, and a rejected promise nobody awaited — the last
 * two being how the 400-invocation leak actually happened.
 */
export function installUnwind(): void {
  if (installed) return;
  installed = true;
  const bail = (code: number, why: string) => (reason?: unknown) => {
    if (reason !== undefined) console.error(`  [unwind] ${why}:`, firstLine(reason));
    void emergencyUnsubscribe().then(() => process.exit(code));
  };
  process.on("SIGINT", bail(130, "interrupted"));
  process.on("SIGTERM", bail(143, "terminated"));
  process.on("uncaughtException", bail(1, "uncaught exception"));
  process.on("unhandledRejection", bail(1, "unhandled rejection"));
}
