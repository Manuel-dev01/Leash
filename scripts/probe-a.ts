/**
 * PROBE A — what authorizes `placeBinaryOrderFor` on a binary pool?
 *
 * This is the highest-stakes unknown in the build. The entire security claim of
 * Leash is "what lets a third party trade on your behalf, and what stops them
 * doing anything else". Committing to a contract shape before knowing this is
 * how you rewrite the core the week of the deadline.
 *
 * The experiment is comparative, not confirmatory. One simulation tells you
 * little; four identical calls from four different senders tell you exactly
 * where the gate is, because only the CALLER varies:
 *
 *   1. stranger  -> placeBinaryOrderFor(fund, ...)   never granted anything
 *   2. delegate  -> placeBinaryOrderFor(fund, ...)   not yet granted
 *   3. fund      -> placeBinaryOrderFor(fund, ...)   owner acting for itself
 *   4. fund      -> placeBinaryOrder(...)            baseline, no routing
 *
 * If (1) and (2) fail with an authorization error while (3)/(4) get past it,
 * the gate is real and per-caller. If (1) SUCCEEDS, that is a protocol-level
 * finding far more important than our design, and the narrative changes.
 *
 * Read-only: every call is eth_call. Nothing is broadcast.
 */
import "dotenv/config";
import { createPublicClient, http, encodeFunctionData, decodeErrorResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { EC, NETWORK, TOPICS, OrderKind } from "../packages/leash-ec/src/constants.js";
import { binaryPoolWriteAbi } from "@somnia-chain/markets-sdk";

// The generated 418-error table is not re-exported from the package index, so
// load it by path rather than vendoring a copy that would drift.
const errorsPath = resolve(process.cwd(), "node_modules/@somnia-chain/markets-sdk/dist/contractErrorsAbi.js");
const { contractErrorsAbi } = await import(pathToFileURL(errorsPath).href);

const RPC = process.env.RPC_URL ?? NETWORK.rpc;
const client = createPublicClient({ transport: http(RPC) });

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};

const binaryPoolParamsAbi = [{
  type: "function", name: "getBinaryPoolParams", stateMutability: "view", inputs: [],
  outputs: [{ type: "tuple", components: [
    { name: "collateralToken", type: "address" }, { name: "market", type: "address" },
    { name: "outcomeToken", type: "address" }, { name: "yesId", type: "uint256" },
    { name: "noId", type: "uint256" }, { name: "oneCollateral", type: "uint256" },
    { name: "setBacking", type: "uint256" }, { name: "feeRecipient", type: "address" },
    { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" },
    { name: "maxBuilderFeeBpsTimes1k", type: "uint256" }, { name: "settlementFeeBpsTimes1k", type: "uint256" },
    { name: "settlement", type: "address" }, { name: "marketNonce", type: "uint64" },
    { name: "finalized", type: "bool" },
  ]}],
}] as const;

/**
 * Turn whatever a failed eth_call threw into a named Solidity error.
 *
 * Care is needed here: a naive regex over the serialized error happily matches
 * the SENDER ADDRESS and reports it as a revert selector, which is worse than
 * useless on a probe whose whole purpose is telling senders apart. So walk
 * viem's error chain for genuine revert data instead.
 */
function revertData(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const k of ["data", "raw"]) {
      const v = o[k];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v as Hex;
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).data === "string") {
        const d = (v as Record<string, string | undefined>).data;
        if (d && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex;
      }
    }
    for (const k of ["cause", "error", "details", "walk"]) {
      if (o[k] && typeof o[k] === "object") stack.push(o[k]);
    }
  }
  return null;
}

function explain(err: unknown): string {
  const data = revertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: contractErrorsAbi, data });
      const args = d.args?.length ? `(${d.args.map(String).join(", ")})` : "";
      return `${d.errorName}${args}`;
    } catch {
      return `revert, undecoded selector ${data.slice(0, 10)} (data ${data.slice(0, 42)}...)`;
    }
  }
  const o = err as { shortMessage?: string; message?: string };
  return (o.shortMessage ?? o.message ?? "unknown").split(String.fromCharCode(10))[0] ?? "unknown";
}

async function main() {
  const fund = acct("FUND_KEY"), delegate = acct("DELEGATE_KEY"), stranger = acct("STRANGER_KEY");
  console.log("\nPROBE A — what authorizes placeBinaryOrderFor?\n");
  console.log(`  fund     ${fund.address}`);
  console.log(`  delegate ${delegate.address}`);
  console.log(`  stranger ${stranger.address}\n`);

  // --- find a live, non-finalized binary pool with recent flow ------------
  const head = await client.getBlockNumber();
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [{
      fromBlock: `0x${(head - 300n).toString(16)}`, toBlock: `0x${head.toString(16)}`,
      topics: [TOPICS.BinaryOrderPlaced],
    }],
  } as never)) as unknown as { address: string }[];
  const seen = [...new Set(logs.map((l) => l.address.toLowerCase()))];
  console.log(`  ${seen.length} pools with flow in the last ~30s`);

  let pool: Address | null = null;
  let params: Record<string, unknown> | null = null;
  for (const cand of seen) {
    try {
      const p = (await client.readContract({
        address: cand as Address, abi: binaryPoolParamsAbi, functionName: "getBinaryPoolParams",
      })) as Record<string, unknown>;
      if (p.finalized === false) { pool = cand as Address; params = p; break; }
    } catch { /* not a binary pool */ }
  }
  if (!pool || !params) throw new Error("no live non-finalized binary pool found");

  console.log(`  pool     ${pool}`);
  console.log(`  market   ${params.market}`);
  console.log(`  collat   ${params.collateralToken}  oneCollateral=${params.oneCollateral}`);
  console.log(`  nonce    ${params.marketNonce}  finalized=${params.finalized}\n`);

  // --- build one plausible order, reused verbatim by every sender ---------
  // price is a probability in collateral units (6dp) and must sit on the tick
  // grid (0.001 -> 1000 raw). 0.100 is deep enough not to cross anything.
  const price = 100_000n;
  const quantity = 1_000_000n;
  const expireNs = BigInt((Date.now() + 30_000)) * 1_000_000n;
  const common = [OrderKind.BUY_YES, price, quantity, expireNs, 0, 0,
                  "0x0000000000000000000000000000000000000000" as Address, 0n, 0n] as const;

  const cases: { label: string; from: Address; data: Hex }[] = [
    { label: "1. stranger -> placeBinaryOrderFor(fund)", from: stranger.address,
      data: encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor",
        args: [fund.address, ...common] as never }) },
    { label: "2. delegate -> placeBinaryOrderFor(fund)", from: delegate.address,
      data: encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor",
        args: [fund.address, ...common] as never }) },
    { label: "3. fund     -> placeBinaryOrderFor(fund)", from: fund.address,
      data: encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor",
        args: [fund.address, ...common] as never }) },
    { label: "4. fund     -> placeBinaryOrder(self)", from: fund.address,
      data: encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: "placeBinaryOrder",
        args: [...common] as never }) },
  ];

  console.log("  identical order, only the CALLER varies:\n");
  for (const c of cases) {
    try {
      const r = await client.call({ account: c.from, to: pool, data: c.data });
      console.log(`  OK     ${c.label}`);
      console.log(`         returned ${r.data ?? "0x"}`);
    } catch (e) {
      console.log(`  REVERT ${c.label}`);
      console.log(`         ${explain(e)}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
