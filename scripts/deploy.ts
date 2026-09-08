/**
 * Deploy MandateRegistry + DeadhandHandler, in that order.
 *
 * The handler's `registry` pointer is IMMUTABLE, so the registry can never move
 * on its own — a registry redeploy always drags the handler with it. That
 * coupling is the reason this is one script and not two.
 *
 * Nothing here is idempotent and nothing here is clever: it deploys, waits for
 * receipts, reads back the constructor state it just set, and prints the two
 * lines that need to go into `.env`. Writing them is deliberately manual —
 * clobbering a live address from a script is how you lose the deployment you
 * meant to keep.
 *
 *   npx tsx scripts/deploy.ts            # dry run: says what it WOULD do
 *   npx tsx scripts/deploy.ts --confirm  # actually deploys
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://dream-rpc.somnia.network";
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;

/**
 * The cap the handler is constructed with.
 *
 * Deliberately conservative at deploy time. The real value comes from
 * `stage3-live.ts` measuring THIS bytecode — a cap carried over from another
 * deployment is a number about another program, and the last time that was
 * assumed the shipped cap would have run out of gas on camera.
 */
const INITIAL_BATCH_CAP = 8n;

const chain = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

function artifact(name: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const key = process.env.FUND_KEY;
  if (!key) throw new Error("FUND_KEY missing from .env");

  // Keys in .env are stored without the 0x prefix, as every other script here assumes.
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const w = createWalletClient({ account, chain, transport: http(RPC) });

  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer   ${account.address}`);
  console.log(`balance    ${formatEther(bal)} STT`);
  console.log(`collateral ${COLLATERAL}`);
  console.log(`batch cap  ${INITIAL_BATCH_CAP} (provisional — stage3 re-fits it against this bytecode)`);
  console.log(`current    registry ${process.env.MANDATE_REGISTRY} / handler ${process.env.DEADHAND_HANDLER}`);

  if (!confirm) {
    console.log("\nDRY RUN. Nothing deployed. Re-run with --confirm.");
    return;
  }
  if (bal < 2n * 10n ** 18n) throw new Error("under 2 STT — top up before deploying");

  const reg = artifact("MandateRegistry");
  console.log("\ndeploying MandateRegistry…");
  const regHash = await w.deployContract({
    abi: reg.abi as never, bytecode: reg.bytecode, args: [COLLATERAL],
  });
  const regRc = await pub.waitForTransactionReceipt({ hash: regHash });
  if (regRc.status !== "success" || !regRc.contractAddress) throw new Error("registry deploy reverted");
  const registry = regRc.contractAddress;
  console.log(`  ${registry}  (gas ${regRc.gasUsed})  tx ${regHash}`);

  const han = artifact("DeadhandHandler");
  console.log("deploying DeadhandHandler…");
  const hanHash = await w.deployContract({
    abi: han.abi as never, bytecode: han.bytecode, args: [registry, INITIAL_BATCH_CAP],
  });
  const hanRc = await pub.waitForTransactionReceipt({ hash: hanHash });
  if (hanRc.status !== "success" || !hanRc.contractAddress) throw new Error("handler deploy reverted");
  const handler = hanRc.contractAddress;
  console.log(`  ${handler}  (gas ${hanRc.gasUsed})  tx ${hanHash}`);

  // Read back what we think we just set, from chain rather than from intent.
  const readReg = await pub.readContract({
    address: handler, functionName: "registry",
    abi: [{ type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
  });
  const cap = await pub.readContract({
    address: handler, functionName: "batchCap",
    abi: [{ type: "function", name: "batchCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
  });
  const backed = await pub.readContract({
    address: registry, functionName: "claimsAreBacked",
    abi: [{ type: "function", name: "claimsAreBacked", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }],
  });
  console.log(`\nhandler.registry() = ${readReg}  ${String(readReg).toLowerCase() === registry.toLowerCase() ? "OK" : "MISMATCH"}`);
  console.log(`handler.batchCap() = ${cap}`);
  console.log(`registry.claimsAreBacked() = ${backed}  (a fresh registry owes nobody anything)`);

  console.log("\n--- put these in .env, then run scripts/retarget.ts ---");
  console.log(`MANDATE_REGISTRY=${registry}`);
  console.log(`DEADHAND_HANDLER=${handler}`);
}

void main().catch((e) => { console.error(e); process.exit(1); });
