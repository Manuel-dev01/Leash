/**
 * Subscription unwind for the failure path.
 *
 * A crash in a polling loop once left a subscription armed and unattended. It
 * burned ~0.19 STT across 400 invocations before anyone noticed — cheap that
 * time, because someone was watching. The same bug during the 5 Sep freeze
 * window, or overnight, is not.
 *
 * So: any script that ARMS a subscription installs this. It runs on an
 * unhandled failure and on Ctrl-C, and it says loudly when it could not unwind,
 * because a silent failure here is the expensive kind.
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

export async function emergencyUnsubscribe(): Promise<void> {
  const key = process.env.FUND_KEY;
  const handler = process.env.DEADHAND_HANDLER;
  if (!key || !handler) return;
  try {
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const id = (await pub.readContract({
      address: handler as Address, abi, functionName: "subscriptionId",
    })) as bigint;
    if (id === 0n) return; // nothing armed
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    const w = createWalletClient({ account, chain, transport: http(RPC) });
    const hash = await w.writeContract({ address: handler as Address, abi, functionName: "unsubscribeNow" });
    await pub.waitForTransactionReceipt({ hash });
    console.error(`  [unwind] subscription ${id} cancelled after failure`);
  } catch (e) {
    // Loud: an un-unwound subscription silently spends money for as long as it
    // takes someone to notice.
    console.error(
      `  [unwind] COULD NOT CANCEL the subscription on ${handler} — cancel it by hand NOW.`,
      (e as Error).message.split(String.fromCharCode(10))[0],
    );
  }
}

/** Install on a script that arms a subscription. Handles crash and Ctrl-C. */
export function installUnwind(): void {
  process.on("SIGINT", () => { void emergencyUnsubscribe().then(() => process.exit(130)); });
  process.on("SIGTERM", () => { void emergencyUnsubscribe().then(() => process.exit(143)); });
}
