/**
 * Leash preflight. Read-only: sends no transactions, needs no keys.
 *
 * Asserts the handful of things whose silent failure would kill the demo:
 *   1. we are on Shannon (50312), not mainnet
 *   2. every pinned topic0 still matches its signature
 *   3. the EC contracts we depend on still have code
 *   4. collateral decimals are READ, never assumed
 *   5. MarketFinalized is actually firing  <- the Layer 2 gate, re-checked every run
 *   6. the binary books have real order flow
 *
 * Run it before every rehearsal. Cheap, and it turns "the demo mysteriously
 * did nothing" into a named failure before the camera is on.
 */
import "dotenv/config";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { EC, NETWORK, TOPICS } from "../packages/leash-ec/src/constants.js";
import { checkTopics } from "../packages/leash-ec/src/topics.js";

const RPC = process.env.RPC_URL ?? NETWORK.rpc;
const client = createPublicClient({ transport: http(RPC) });

/**
 * Raw eth_getLogs by topic0. viem's typed `getLogs` wants an `event`/`events`
 * ABI, but we deliberately filter on the PINNED topic0 — the whole point of
 * topics.ts is that we trust the reconciled hash, not a locally-declared ABI
 * that could drift from the deployed contract.
 */
async function logsByTopic(
  topic0: string,
  fromBlock: bigint,
  toBlock: bigint,
  address?: Address,
): Promise<{ address: string }[]> {
  const params: Record<string, unknown> = {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    topics: [topic0],
  };
  if (address) params.address = address;
  return (await client.request({
    method: "eth_getLogs",
    params: [params],
  } as unknown as Parameters<typeof client.request>[0])) as unknown as { address: string }[];
}

let failures = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL  ${m}`); };
const info = (m: string) => console.log(`        ${m}`);

async function main() {
  console.log(`\nLeash doctor — ${RPC}\n`);

  // 1 ---------------------------------------------------------------- network
  console.log("network");
  const chainId = await client.getChainId();
  chainId === NETWORK.chainId
    ? ok(`chain ${chainId} (Shannon testnet)`)
    : bad(`chain ${chainId}, expected ${NETWORK.chainId} — WRONG NETWORK`);
  const head = await client.getBlockNumber();
  info(`head block ${head}`);

  // 2 ----------------------------------------------------------------- topics
  console.log("\ntopic0 reconciliation (pinned vs derived)");
  for (const c of checkTopics()) {
    c.ok ? ok(`${c.name}`) : bad(`${c.name}\n          pinned ${c.pinned}\n          derived ${c.derived}`);
  }

  // 3 -------------------------------------------------------------- contracts
  console.log("\nEvent Contract core has code");
  for (const [name, addr] of Object.entries(EC)) {
    if (!addr.startsWith("0x") || addr.length !== 42) continue;
    const code = await client.getCode({ address: addr as Address });
    code && code !== "0x" ? ok(`${name} ${addr}`) : bad(`${name} ${addr} — NO CODE`);
  }

  // 4 -------------------------------------------------------------- decimals
  console.log("\ncollateral (read, never assumed)");
  const erc20 = [
    { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
    { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  ] as const;
  const dec = await client.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "decimals" });
  const sym = await client.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "symbol" });
  info(`${sym} @ ${EC.collateral} — decimals ${dec}`);
  dec === 6
    ? ok("6 decimals, as recorded (NOT the 18 that CLAUDE.md §4.2 r9 implies for spot)")
    : bad(`decimals ${dec} — constants.ts says 6. Re-verify before sizing any mandate.`);

  // 5 ------------------------------------------------------- the Layer 2 gate
  console.log("\nLayer 2 gate — is MarketFinalized firing?");
  const span = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  let finals = 0;
  for (let i = 0; i < 5; i++) {
    const hi = head - BigInt(i) * BigInt(NETWORK.maxGetLogsBlockRange);
    const logs = await logsByTopic(
      TOPICS.MarketFinalized,
      hi - span,
      hi,
      EC.binaryModule as Address,
    );
    finals += logs.length;
  }
  const secs = 5 * NETWORK.maxGetLogsBlockRange * NETWORK.blockTimeSec;
  finals > 0
    ? ok(`${finals} MarketFinalized in the last ~${secs}s (~1 per ${(secs / finals).toFixed(0)}s)`)
    : bad(`0 MarketFinalized in ~${secs}s — Layer 2 has nothing to fire on. Check the venue is still creating markets.`);

  // 6 ------------------------------------------------------------ order flow
  //
  // SAMPLE A NARROW WINDOW ON PURPOSE. A chain-wide BinaryOrderPlaced scan over
  // the full 1000-block getLogs range returns 13-16 MB and blows viem's 10 MB
  // response cap outright (measured 2026-08-23). The books are busy enough that
  // 200 blocks (~20s) is an ample sample. Anything needing complete history must
  // scope by address AND window — never scan chain-wide.
  console.log("\norder flow on binary books");
  const placed = await logsByTopic(TOPICS.BinaryOrderPlaced, head - 200n, head);
  const pools = new Set(placed.map((l) => l.address));
  placed.length > 0
    ? ok(`${placed.length} BinaryOrderPlaced across ${pools.size} pools in ~${200 * NETWORK.blockTimeSec}s`)
    : bad("no binary order flow — self-funding the book becomes a hard dependency");

  // wallets ---------------------------------------------------------------
  console.log("\nwallets");
  for (const k of ["DELEGATOR_ADDRESS", "DELEGATE_ADDRESS"] as const) {
    const a = process.env[k];
    if (!a) { info(`${k} unset`); continue; }
    const bal = await client.getBalance({ address: a as Address });
    info(`${k} ${a} — ${formatUnits(bal, 18)} STT`);
    if (bal === 0n) bad(`${k} has zero STT`);
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\ndoctor crashed:", e); process.exit(1); });
