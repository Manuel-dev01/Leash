/**
 * Set the handler's batch cap.
 *
 * Used for two different jobs, and it matters which:
 *
 *  - BEFORE measuring, raise it so the batch is not clipped. A clipped batch
 *    measures the cap, not the work.
 *  - AFTER fitting, set the shipped value from the line across >= 2 batch sizes.
 *    Never from one point: the same handler once "measured" 171,964 and then
 *    106,422 gas per mandate against a true marginal of ~56,700, because a
 *    single point cannot separate fixed cost from marginal.
 *
 *   npx tsx scripts/setcap.ts 40
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://dream-rpc.somnia.network";
const chain = {
  id: 50312, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const abi = parseAbi(["function batchCap() view returns (uint256)", "function setBatchCap(uint256)"]);

async function main() {
  const n = BigInt(process.argv[2] ?? "");
  if (!n || n <= 0n) throw new Error("usage: tsx scripts/setcap.ts <n>");
  const handler = process.env.DEADHAND_HANDLER as Address;
  if (!handler) throw new Error("DEADHAND_HANDLER missing");
  const k = process.env.FUND_KEY!;
  const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const w = createWalletClient({ account, chain, transport: http(RPC) });

  const before = await pub.readContract({ address: handler, abi, functionName: "batchCap" });
  const hash = await w.writeContract({ address: handler, abi, functionName: "setBatchCap", args: [n] });
  const r = await pub.waitForTransactionReceipt({ hash });
  const after = await pub.readContract({ address: handler, abi, functionName: "batchCap" });
  console.log(`batchCap ${before} -> ${after}  (${r.status})  ${hash}`);
  if (after !== n) throw new Error("cap did not take");
}
void main().catch((e) => { console.error(e); process.exit(1); });
