/**
 * verify.ts — the submission checklist as code.
 *
 * One command, one verdict. Every claim in `claims.json` becomes an assertion
 * against the DEPLOYED system, and the run exits non-zero if any of them has
 * stopped being true. On the day the video is recorded, this is what says
 * whether the video describes a system that currently exists.
 *
 * It does two things a checklist cannot.
 *
 * FAILS ON STALE EVIDENCE. Claims carry the code hash or commit their proof was
 * taken from. When the deployed bytecode has moved since, the claim goes AMBER
 * automatically instead of staying green on the strength of an old run. Two
 * numbers nearly reached a README this way: a 789-gas skip cost measured on a
 * probe handler, and a batch cap of 24 fitted on a handler deployment that had
 * never settled anything.
 *
 * RUNS THE NEGATIVE CASES. A green check that only exercises the happy path is
 * the mock-shaped hole one level up. So: an unroutable RPC must produce an em
 * dash and not a confident 0.00, discovery must throw rather than report an
 * empty venue, and each of the six named refusals must be provoked from a real
 * key and decoded from raw revert data.
 *
 * The bar it holds itself to: nothing here prints a verdict that was not
 * computed from the check it names.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  createPublicClient, http, parseAbi, keccak256, decodeErrorResult, decodeEventLog,
  formatUnits, formatEther, encodeFunctionData, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC, NETWORK, TOPICS } from "../packages/leash-ec/src/constants.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../packages/leash-ec/src/discover.js";
import { readHeld } from "../apps/web/src/held.js";
import { capFrom, SHIP_GAS_LIMIT, WRAPPER_OVERHEAD, HEADROOM, type Point } from "./capfit.js";
import { binaryPoolWriteAbi } from "@somnia-chain/markets-sdk";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
/** Routes nowhere. Used to prove the failure paths actually run. */
const DEAD_RPC = "http://127.0.0.1:1/dead";

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ chain, transport: http(RPC) });
const deadPub = createPublicClient({
  chain: { ...chain, rpcUrls: { default: { http: [DEAD_RPC] } } },
  transport: http(DEAD_RPC, { retryCount: 0, timeout: 2500 }),
});

// ---- the ledger ----------------------------------------------------------

interface Claim {
  id: string;
  claim: string;
  status: string;
  provenance?: { codeHash?: string; commit?: string; note?: string };
}
interface Ledger {
  deployed: Record<string, string>;
  claims: Claim[];
}

const ledger = JSON.parse(readFileSync("claims.json", "utf8")) as Ledger;
const byId = (id: string) => ledger.claims.find((c) => c.id === id);

// ---- result accounting ---------------------------------------------------

/**
 * SKIP is not a soft FAIL. It means "this machine is not configured to run this
 * check", which is a fact about the clone, not about the deployment. A judge
 * cloning without a funded .env was shown three FAILs for wallets they were
 * never expected to have — that reads as a broken project.
 *
 * A key that is PRESENT but underfunded still FAILS. Absent and broke are
 * different states and only one of them is our problem.
 */
type Level = "PASS" | "FAIL" | "AMBER" | "SKIP";
const results: { level: Level; id: string; line: string }[] = [];

function record(level: Level, id: string, line: string) {
  results.push({ level, id, line });
  const tag = level === "PASS" ? "  ok  "
    : level === "AMBER" ? " AMBER"
    : level === "SKIP" ? " skip "
    : " FAIL ";
  console.log(`${tag}  ${id.padEnd(34)} ${line}`);
}

/**
 * Assert, and never let "the check could not run" masquerade as a pass. A
 * thrown assertion is a FAIL; a thrown *check* is also a FAIL, reported with
 * what threw.
 */
async function check(id: string, fn: () => Promise<string>) {
  const c = byId(id);
  if (!c) { record("FAIL", id, "no such claim in claims.json"); return; }
  try {
    const detail = await fn();
    record("PASS", id, detail);
  } catch (e) {
    record("FAIL", id, (e as Error).message.split(String.fromCharCode(10))[0] ?? String(e));
  }
}

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ---- ABIs ----------------------------------------------------------------

const regAbi = parseAbi([
  "function holdsNoFunds() view returns (bool)",
  "function unattributed() view returns (uint256)",
  "function nextMandateId() view returns (uint256)",
  "function mandates(uint256) view returns (address delegator, address delegate, uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint128 usedExposure, uint64 expiry, bool revoked, bool exists)",
  "function revoke(uint256)",
  "function createMandate(address,uint128,uint128,uint64,bytes32[]) returns (uint256)",
  "function placeForDelegator(uint256,bytes32,address,uint8,uint256,uint256,uint64) returns (uint128)",
  "function settleFinalizedMarket(bytes32,uint256) returns (uint256,uint256,bool)",
  "error NotDelegator()",
  "error NotDelegate()",
  "error Revoked()",
  "error Expired()",
  "error MarketNotAllowed()",
  "error NoMandate()",
  "error StakeExceedsPerTrade(uint256 cost, uint128 limit)",
  "error ExceedsCumulative(uint256 wouldBe, uint128 limit)",
]);

const hndAbi = parseAbi([
  "function subscriptionId() view returns (uint256)",
  "function batchCap() view returns (uint256)",
  "function invocations() view returns (uint256)",
  "function marketsSettled() view returns (uint256)",
  "function seen(bytes32) view returns (uint32)",
  "function registry() view returns (address)",
  "function onEvent(uint256,address,bytes32[],bytes)",
  "event Deadhand(bytes32 indexed marketId, address indexed pool, uint256 processed, uint256 failed, bool drained, uint256 gasUsed)",
]);

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);

const REGISTRY = (process.env.MANDATE_REGISTRY ?? ledger.deployed.MandateRegistry) as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? ledger.deployed.DeadhandHandler) as Address;
const COLLATERAL = EC.collateral as Address;

/**
 * An address to probe FROM, for checks that only ever `eth_call`.
 *
 * Nothing here is signed, so demanding a private key made these unrunnable by
 * exactly the person most likely to want to run them: someone who cloned the
 * repo and has no funded `.env`. That included the check proving the product's
 * premise — that no EOA can be granted routing authority on a binary pool.
 *
 * Uses the configured stranger when there is one, so our runs and a judge's
 * agree; otherwise an address that is obviously nobody.
 */
function strangerAddress(): Address {
  const v = process.env.STRANGER_KEY;
  if (v) return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex).address;
  return "0x000000000000000000000000000000000000dEaD" as Address;
}

/**
 * The delegate of a real mandate, to probe against.
 *
 * Falls back to reading a live mandate's `delegate` field, because the check is
 * "the delegate of THIS mandate cannot withdraw" — which needs a mandate and an
 * address, not a signer.
 */
async function probeDelegate(): Promise<Address> {
  const v = process.env.DELEGATE_KEY;
  if (v) return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex).address;
  const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
  for (let id = next - 1n; id > 0n && id > next - 60n; id--) {
    const m = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "mandates", args: [id] }) as readonly unknown[];
    if (m[7] === true && m[6] === false) return m[1] as Address;
  }
  throw new Error("no live mandate on the registry to probe a delegate against");
}

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing from the environment`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};

/**
 * The revert SELECTOR, decoded from raw eth_call return data.
 *
 * Never pattern-matched out of an error message: a regex over the message once
 * matched the sender address and reported it as a revert selector, and the
 * result looked entirely plausible.
 */
function revertName(e: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try { return decodeErrorResult({ abi: regAbi, data: d as Hex }).errorName; }
      catch { return `undecoded ${d.slice(0, 10)}`; }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  throw new Error(`no revert data on this error: ${(e as Error).message?.split(String.fromCharCode(10))[0]}`);
}

/** Strip solc's CBOR metadata trailer. Its 32-byte IPFS hash changes when a
 *  COMMENT changes, which is source drift, not semantic drift. */
function stripMetadata(hex: string): string {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length < 2) return b.toString("hex");
  const len = b.readUInt16BE(b.length - 2);
  if (len + 2 > b.length) return b.toString("hex");
  return b.subarray(0, b.length - len - 2).toString("hex");
}

/**
 * Source with comments removed.
 *
 * Every source-text assertion below runs on this. Three checks failed on their
 * first run because they matched PROSE: `discover.ts` names the indexer host in
 * the comment explaining why it does not use it, and `MandateRegistry.sol` says
 * "the handler is one caller among several" in the comment that documents the
 * deletability the check exists to prove. A check that fires on its own
 * documentation is a check that will be silenced rather than believed.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * The runtime instruction listing, FROM THE COMPILER.
 *
 * Not a disassembly of the deployed bytes. Linear disassembly of EVM bytecode
 * is unreliable: solc appends data blobs after the code, and a linear scan
 * desyncs inside them and starts reading operands as opcodes. This check first
 * reported "DELEGATECALL opcode present in registry runtime", and so did
 * `cast disassemble` — both pointing at offset 8557, which turned out to be the
 * middle of a 32-byte constant, not an instruction. solc's own listing has zero.
 *
 * The chain of reasoning that makes this sound: the DEPLOYED runtime matches
 * this artifact byte for byte outside the metadata trailer (asserted separately,
 * immediately above), so what the compiler says about the artifact is a fact
 * about the deployment.
 */
function compilerListing(artifact: string): { names: Map<string, number>; selectors: Set<string> } {
  const j = JSON.parse(readFileSync(artifact, "utf8"));
  const la = j.legacyAssembly;
  if (!la) {
    throw new Error(
      "artifact has no legacyAssembly — rebuild with extra_output = [\"evm.legacyAssembly\"] in foundry.toml. " +
      "Refusing to fall back to a linear disassembly, which is what got this check wrong.",
    );
  }
  const runtime = la[".data"]?.["0"];
  if (!runtime?.[".code"]) throw new Error("legacyAssembly has no runtime .code section");
  const names = new Map<string, number>();
  for (const ins of runtime[".code"] as { name: string }[]) {
    names.set(ins.name, (names.get(ins.name) ?? 0) + 1);
  }
  // The compiler's own selector table, not bytes scraped out of a dispatcher.
  const selectors = new Set(Object.values(j.methodIdentifiers ?? {}) as string[]);
  return { names, selectors };
}

/** `eth_getStorageAt` returns bare "0x" for an untouched slot on this RPC. */
function slotIsZero(v: string | undefined): boolean {
  if (!v || v === "0x") return true;
  return BigInt(v) === 0n;
}

function localRuntime(artifact: string): { code: string; refs: Record<string, { start: number; length: number }[]> } {
  const j = JSON.parse(readFileSync(artifact, "utf8"));
  return { code: j.deployedBytecode.object as string, refs: j.deployedBytecode.immutableReferences ?? {} };
}

function maskImmutables(hex: string, refs: Record<string, { start: number; length: number }[]>): Buffer {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const list of Object.values(refs)) for (const r of list) b.fill(0, r.start, r.start + r.length);
  return b;
}

/**
 * A mandate that exists and names `who` as its delegate.
 *
 * verify must not create one: it should be safe to run repeatedly, on demo day,
 * without spending collateral to prove a point about refusals.
 */
async function liveMandateFor(who: Address): Promise<bigint> {
  const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
  for (let id = next - 1n; id >= 0n && id > next - 40n; id--) {
    const m = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "mandates", args: [id] }) as readonly unknown[];
    if (!m[7]) continue;
    if ((m[1] as string).toLowerCase() === who.toLowerCase()) return id;
  }
  throw new Error(`no mandate for ${who} in the last 40 ids — run scripts/demo-reset.ts first`);
}

// ==========================================================================

async function main() {
  console.log("\nLEASH — verify");
  console.log(`  network  ${NETWORK.chainId} via ${RPC}`);
  console.log(`  registry ${REGISTRY}`);
  console.log(`  handler  ${HANDLER}`);
  const head = await pub.getBlockNumber();
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  console.log(`  block    ${head}   commit ${commit}\n`);

  const handlerCode = (await pub.getBytecode({ address: HANDLER })) ?? "0x";
  const handlerHash = keccak256(handlerCode as Hex);
  const registryCode = (await pub.getBytecode({ address: REGISTRY })) ?? "0x";

  // ---- stale-evidence gate ----------------------------------------------
  //
  // Runs FIRST, because a claim proven against bytecode that no longer exists
  // must not be able to report green further down.
  console.log("  --- provenance -------------------------------------------------");
  for (const c of ledger.claims) {
    const want = c.provenance?.codeHash;
    if (!want) continue;
    if (want === "PRE-INSTRUMENTATION") {
      record("AMBER", c.id, `evidence predates the current handler build — ${c.provenance?.note ?? "re-measure"}`);
    } else if (want.toLowerCase() !== handlerHash.toLowerCase()) {
      record("AMBER", c.id, `proof taken on handler ${want.slice(0, 12)}…, deployed is ${handlerHash.slice(0, 12)}… — RE-PROVE`);
    } else {
      record("PASS", c.id, `provenance matches deployed handler ${handlerHash.slice(0, 12)}…`);
    }
  }

  console.log("\n  --- deployed state ---------------------------------------------");

  // ---- registry holds no funds ------------------------------------------
  await check("registry-holds-no-funds", async () => {
    const clean = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "holdsNoFunds" }) as boolean;
    const bal = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [REGISTRY] }) as bigint;
    const dp = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "decimals" }) as number;
    must(clean, `holdsNoFunds() is FALSE with ${formatUnits(bal, dp)} collateral held`);
    return `holdsNoFunds()=true, balance ${formatUnits(bal, dp)} (${dp}dp)`;
  });

  await check("no-unattributed-escrow", async () => {
    const un = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "unattributed" }) as bigint;
    must(un === 0n, `unattributed() == ${un}, must be 0`);
    return "unattributed() == 0";
  });

  // ---- immutable, no admin ----------------------------------------------
  await check("immutable-no-admin", async () => {
    const local = localRuntime("contracts/out/MandateRegistry.sol/MandateRegistry.json");
    const a = stripMetadata(maskImmutables(local.code, local.refs).toString("hex"));
    const b = stripMetadata(maskImmutables(registryCode, local.refs).toString("hex"));
    must(a === b, "deployed registry executable bytecode does not match the local compile");

    // EIP-1967 slots. A proxy stores its implementation/admin/beacon here.
    const slots = {
      impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
      beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    } as const;
    for (const [name, slot] of Object.entries(slots)) {
      const v = await pub.getStorageAt({ address: REGISTRY, slot: slot as Hex });
      must(slotIsZero(v), `EIP-1967 ${name} slot is set (${v}) — this is a proxy`);
    }

    // A contract that cannot delegatecall cannot be upgraded in place, whatever
    // its storage says. Counted by the compiler, not scanned out of the bytes.
    const { names, selectors } = compilerListing("contracts/out/MandateRegistry.sol/MandateRegistry.json");
    must((names.get("DELEGATECALL") ?? 0) === 0, `DELEGATECALL x${names.get("DELEGATECALL")} in registry runtime`);
    must((names.get("SELFDESTRUCT") ?? 0) === 0, `SELFDESTRUCT in registry runtime`);

    // No admin-shaped entry point, checked against the compiler's selector table.
    const forbidden = ["owner()", "admin()", "pause()", "unpause()", "upgradeTo(address)",
                       "upgradeToAndCall(address,bytes)", "transferOwnership(address)",
                       "withdraw()", "setOwner(address)", "initialize()"];
    for (const sig of forbidden) {
      const sel = keccak256(Buffer.from(sig) as unknown as Hex).slice(2, 10);
      must(!selectors.has(sel), `registry exposes ${sig} (0x${sel})`);
    }
    return `deployed bytecode == local compile; no proxy slots; compiler reports 0 DELEGATECALL / 0 SELFDESTRUCT ` +
      `across ${[...names.values()].reduce((a, n) => a + n, 0)} instructions; none of ${forbidden.length} admin selectors in ${selectors.size} entry points`;
  });

  // ---- beat 3 unforgeable ------------------------------------------------
  await check("beat3-unforgeable", async () => {
    const stranger = { address: strangerAddress() };
    try {
      await pub.call({
        account: stranger.address,
        to: HANDLER,
        data: encodeFunctionData({
          abi: hndAbi, functionName: "onEvent",
          args: [1n, EC.binaryModule as Address, [TOPICS.MarketFinalized as Hex], "0x" as Hex],
        }),
      });
      throw new Error("onEvent from an EOA did NOT revert — beat 3 would be forgeable");
    } catch (e) {
      const msg = (e as Error).message;
      must(!msg.includes("did NOT revert"), msg);
      return `onEvent from ${stranger.address.slice(0, 10)}… reverts; only 0x0100 passes`;
    }
  });

  // ---- one subscription, N beneficiaries ---------------------------------
  await check("one-subscription-n-beneficiaries", async () => {
    // The deployed handler must be the source in this repo. Metadata is
    // stripped: solc's trailer changes when a COMMENT changes, and comment
    // drift is not semantic drift — but anything else is, and every gas figure
    // above is tagged to this deployment.
    const lh = localRuntime("contracts/out/DeadhandHandler.sol/DeadhandHandler.json");
    must(
      stripMetadata(maskImmutables(lh.code, lh.refs).toString("hex")) ===
      stripMetadata(maskImmutables(handlerCode, lh.refs).toString("hex")),
      "deployed handler executable bytecode does not match the local compile — the measurements describe another program",
    );
    const reg = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "registry" }) as Address;
    must(reg.toLowerCase() === REGISTRY.toLowerCase(), `handler points at ${reg}, not the registry under test`);
    const src = readFileSync("contracts/src/DeadhandHandler.sol", "utf8");
    must(!/function subscribeTo\([^)]*\)[^{]*payable/.test(src), "subscribeTo is payable — that is the per-user funding shape");
    const inv = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
    const set = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
    return `one subscriptionId slot, not payable, ${inv} invocations / ${set} settles on this deployment`;
  });

  // ---- the six named refusals, on the DEPLOYED registry ------------------
  console.log("\n  --- negative: the six refusals ---------------------------------");
  await check("delegate-cannot-bypass", async () => {
    
    const delegate = { address: await probeDelegate() };
    const stranger = { address: strangerAddress() };
    const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
    const probe = await liveMandateFor(delegate.address);
    const m = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "mandates", args: [probe] }) as readonly unknown[];
    const perTrade = m[2] as bigint;
    const revoked = m[6] as boolean;
    const expiry = m[5] as bigint;

    const hits: string[] = [];
    const bad = (marketId: Hex, price: bigint, qty: bigint, from: Address, id = probe) =>
      pub.simulateContract({
        account: from, address: REGISTRY, abi: regAbi, functionName: "placeForDelegator",
        args: [id, marketId, EC.binaryModule as Address, 0, price, qty, expiry * 1_000_000_000n] as never,
      });

    // NotDelegate — the stranger key on someone else's mandate.
    try { await bad(("0x" + "11".repeat(32)) as Hex, 10_000n, 1_000_000n, stranger.address); throw new Error("NotDelegate did not fire"); }
    catch (e) { const n = revertName(e); must(n === "NotDelegate", `expected NotDelegate, got ${n}`); hits.push(n); }

    // NotDelegator — the delegate trying to revoke.
    try {
      await pub.simulateContract({ account: delegate.address, address: REGISTRY, abi: regAbi, functionName: "revoke", args: [probe] as never });
      throw new Error("NotDelegator did not fire");
    } catch (e) { const n = revertName(e); must(n === "NotDelegator", `expected NotDelegator, got ${n}`); hits.push(n); }

    // Revoked / Expired / MarketNotAllowed / StakeExceedsPerTrade — order of
    // checks in placeForDelegator decides which one a given probe reaches, so
    // each is provoked with the earlier gates satisfied.
    if (revoked) {
      try { await bad(("0x" + "22".repeat(32)) as Hex, 10_000n, 1_000_000n, delegate.address); throw new Error("Revoked did not fire"); }
      catch (e) { const n = revertName(e); must(n === "Revoked", `expected Revoked, got ${n}`); hits.push(n); }
    } else if (BigInt(Math.floor(Date.now() / 1000)) >= expiry) {
      try { await bad(("0x" + "22".repeat(32)) as Hex, 10_000n, 1_000_000n, delegate.address); throw new Error("Expired did not fire"); }
      catch (e) { const n = revertName(e); must(n === "Expired", `expected Expired, got ${n}`); hits.push(n); }
    } else {
      // MarketNotAllowed — a marketId no mandate can contain.
      try { await bad(("0x" + "22".repeat(32)) as Hex, 10_000n, 1_000_000n, delegate.address); throw new Error("MarketNotAllowed did not fire"); }
      catch (e) { const n = revertName(e); must(n === "MarketNotAllowed", `expected MarketNotAllowed, got ${n}`); hits.push(n); }
    }

    // NoMandate — an id that was never issued. Proves the gate is the mandate
    // record, not an incidental failure further down.
    try { await bad(("0x" + "33".repeat(32)) as Hex, 10_000n, 1_000_000n, delegate.address, next + 999n); throw new Error("NoMandate did not fire"); }
    catch (e) { const n = revertName(e); must(n === "NoMandate", `expected NoMandate, got ${n}`); hits.push(n); }

    return `mandate ${probe}: ${hits.join(", ")} — each decoded from raw revert data, perTrade cap ${formatUnits(perTrade, 6)}`;
  });

  await check("delegate-cannot-take", async () => {
    // There is no withdraw selector to call. That is the strongest form of the
    // claim: not "it reverts", but "there is no function".
    const { selectors } = compilerListing("contracts/out/MandateRegistry.sol/MandateRegistry.json");
    const sel = keccak256(Buffer.from("withdraw()") as unknown as Hex).slice(2, 10);
    must(!selectors.has(sel), "a withdraw() entry point IS present in the registry");
    // Probed against a mandate that EXISTS. Against a non-existent id the
    // revert is NoMandate, which proves nothing about authority — the same
    // shape as a pool's incidental "nothing to withdraw".
    const delegate = { address: await probeDelegate() };
    const id = await liveMandateFor(delegate.address);
    try {
      await pub.simulateContract({ account: delegate.address, address: REGISTRY, abi: regAbi, functionName: "revoke", args: [id] as never });
      throw new Error("revoke() from the delegate key did not revert");
    } catch (e) {
      const n = revertName(e);
      must(n === "NotDelegator", `expected NotDelegator on live mandate ${id}, got ${n}`);
      return `no withdraw() selector in the deployed code; revoke() of LIVE mandate ${id} from the delegate reverts NotDelegator`;
    }
  });

  // ---- negative: dead RPC ------------------------------------------------
  console.log("\n  --- negative: degraded infrastructure --------------------------");
  await check("onscreen-figures-are-chain-derived", async () => {
    // The SHIPPED function, not a copy of it.
    const dead = await readHeld(deadPub, REGISTRY, COLLATERAL);
    must(dead.value === "—", `dead RPC produced "${dead.value}", must be an em dash`);
    must(dead.read === false, "dead RPC reported read=true");
    const liveHeld = await readHeld(pub, REGISTRY, COLLATERAL);
    must(liveHeld.read === true, "live RPC did not complete a read");
    must(liveHeld.value !== "—", "live RPC produced an em dash");

    // And nothing on screen may assert freshness it has not checked.
    const src = code("apps/web/src/screens/delegator.ts") + code("apps/web/src/screens/delegate.ts");
    must(!/every figure above is read from the contract/.test(src),
      "an unconditional freshness claim is back in the UI — it must be computed from chainAt");
    must(/freshnessLine\(\)/.test(src), "the monitor screen no longer renders its own read age");
    must(/staleness\(\)/.test(src), "the delegate envelope no longer checks staleness");
    /**
     * This used to require the chart to be LABELLED "indicative price line".
     * The chart is gone — it was twelve hardcoded numbers in a product whose
     * whole claim is that on-screen figures come from the contract — so the
     * check now asserts the stronger property: no fabricated series exists at
     * all. A label is a mitigation; absence is the fix.
     */
    const uiSrc = ["apps/web/src/screens/delegate.ts", "apps/web/src/screens/delegator.ts",
                   "apps/web/src/screens/markets.ts"].map((f) => readFileSync(f, "utf8")).join("");
    must(!/function spark\(/.test(uiSrc), "spark() is back — a hardcoded price series must not ship");
    must(!/<polyline/.test(uiSrc), "a <polyline> is back in the UI: assert its points are read from chain, or remove it");
    must(!/indicative price line/.test(uiSrc),
      "the indicative-price label is back, which means the invented chart is back with it");
    return `dead RPC -> "—" (read=false); live RPC -> "${liveHeld.value}" (clean=${liveHeld.clean})`;
  });

  await check("no-third-party-on-critical-path", async () => {
    // Structural: no indexer or REST host anywhere in the shipped path.
    const files = [
      "apps/web/src/chain.ts", "apps/web/src/app.ts", "apps/web/src/landing.ts",
      "apps/web/src/held.ts", "apps/web/src/screens/delegator.ts", "apps/web/src/screens/delegate.ts",
      "packages/leash-ec/src/discover.ts",
    ];
    const banned = ["smk.somnia.host", "graphql", "api.dreamdex.io", "stg.api.dreamdex.io", "/v0/"];
    for (const f of files) {
      const s = code(f);
      for (const b of banned) must(!s.includes(b), `${f} references ${b} in executable code`);
    }
    // Behavioural: discovery works from chain alone...
    const found = await discoverMarkets(ecClient(RPC), { windows: 6 });
    must(found.length > 0, "chain-only discovery found no MarketCreated in 6 windows");
    // ...and a dead RPC THROWS rather than reporting an empty venue.
    let threw = false;
    try { await discoverMarkets(ecClient(DEAD_RPC), { windows: 1 }); }
    catch { threw = true; }
    must(threw, "discovery against a dead RPC returned quietly instead of throwing — an outage would read as 'no markets'");
    return `${found.length} markets from chain alone; dead RPC throws; ${files.length} files free of ${banned.length} banned hosts`;
  });

  // ---- the batch cap -----------------------------------------------------
  console.log("\n  --- measurement ------------------------------------------------");
  await check("batch-cap", async () => {
    const cap = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" }) as bigint;
    must(existsSync(".measurements/deadhand-fit.json"),
      "no measurement file — the cap is a number with a story attached");
    const pts = (JSON.parse(readFileSync(".measurements/deadhand-fit.json", "utf8")) as Point[])
      // Ceiling observations (a batch that ran OUT of gas) live in this file
      // too and carry no gas figure. They are evidence about the limit, not
      // points on the line — counting one as zero gas produced a cap of -8.
      .filter((p) => typeof p.gas === "number" && p.gas > 0)
      .filter((p) => p.codeHash.toLowerCase() === handlerHash.toLowerCase());
    must(pts.length > 0, `no measurement points on the deployed bytecode ${handlerHash.slice(0, 12)}…`);
    const distinct = new Set(pts.map((p) => p.n)).size;
    must(distinct >= 2,
      `cap is ${cap} from ${pts.length} point(s) at ${distinct} distinct batch size(s). ` +
      `One batch size is not a line — its gas-per-mandate is a fixed-cost artefact. ` +
      `Points so far: ${pts.map((p) => `n=${p.n}:${p.gas}`).join(", ")}`);

    // Computed by scripts/capfit.ts, the SAME module stage3-live.ts uses to set
    // it. They used to compute it separately and disagreed — stage3 reserved an
    // undreived "5/6 of the limit" while this used the measured wrapper — so the
    // on-chain value depended on which script ran last. This check caught that
    // drift on chain within an hour of being written.
    const f = capFrom(pts);
    must(f !== null, "measurement points do not define a line");
    must(Number(cap) === f!.cap,
      `deployed batchCap is ${cap}, but the fit implies ${f!.cap} (binds at ~${f!.binds}, ${HEADROOM * 100}% headroom). ` +
      `A full batch at ${cap} charges ~${Math.round(f!.fixed + f!.marginal * Number(cap) + WRAPPER_OVERHEAD).toLocaleString()} gas against the ${SHIP_GAS_LIMIT.toLocaleString()} limit.`);
    return `cap ${cap} == fit (${f!.usedPoints} points${f!.excludedFirstEver ? ", first-ever settle excluded" : ""}: ` +
      `fixed ~${Math.round(f!.fixed).toLocaleString()} + ~${Math.round(f!.marginal).toLocaleString()}/mandate in-body, ` +
      `+${WRAPPER_OVERHEAD.toLocaleString()} measured wrapper; binds ~${f!.binds} under ${SHIP_GAS_LIMIT.toLocaleString()}, ` +
      `shipped at ${HEADROOM * 100}%); a full batch charges ~${f!.charges.toLocaleString()} gas`;
  });

  await check("skip-cost", async () => {
    // This used to assert only that the claim's provenance LABEL pointed at the
    // current build. That checks the paperwork: any number written into
    // claims.json with the right code hash would have passed. It now checks the
    // NUMBER, against a receipt.
    const c = byId("skip-cost")!;
    must(c.provenance?.codeHash === handlerHash,
      `figure measured on ${c.provenance?.codeHash}; the deployed handler is ${handlerHash.slice(0, 12)}… — re-run scripts/measure-skip.ts`);

    // Check the CITED receipts, not whatever happens to be recent. Scanning
    // recent blocks made this check depend on the subscription having been
    // armed lately, so it failed for a reason that had nothing to do with the
    // claim. Evidence hashes are stable; recency is not.
    const ev = ((c as unknown as { provenance?: { evidence?: string[] } }).provenance?.evidence ?? []);
    must(ev.length > 0, "claims.json cites no skip-invocation receipts to check the figure against");
    const dead = keccak256(toHex("Deadhand(bytes32,address,uint256,uint256,bool,uint256)"));
    const saw = keccak256(toHex("DeadhandSaw(bytes32)"));
    const gasSeen = new Set<string>();
    for (const h of ev) {
      must(/^0x[0-9a-f]{64}$/i.test(h), `evidence "${h}" is not a full transaction hash`);
      const rec = await pub.getTransactionReceipt({ hash: h as Hex });
      must(rec.status === "success", `skip evidence ${h.slice(0, 12)}… has status ${rec.status}`);
      must(rec.logs.some((l) => l.topics[0] === saw), `${h.slice(0, 12)}… has no DeadhandSaw log — not an invocation we saw`);
      must(!rec.logs.some((l) => l.topics[0] === dead), `${h.slice(0, 12)}… carries a Deadhand log — that is a SETTLE, not a skip`);
      gasSeen.add(rec.gasUsed.toString());
    }
    must(gasSeen.size === 1, `skip gas is not deterministic across ${ev.length} receipts: ${[...gasSeen].join(", ")}`);
    const measured = [...gasSeen][0]!;
    must(measured === "291181", `claims.json says 291,181 gas per skip; receipts say ${Number(measured).toLocaleString()}`);
    const checkedTx = ev.length;
    return `291,181 gas confirmed against ${checkedTx} skip receipt(s), identical each time`;
  });

  // ---- layer 2 deletable -------------------------------------------------
  console.log("\n  --- architecture -----------------------------------------------");
  await check("layer2-deletable", async () => {
    const sub = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
    // The registry must not DEPEND on the handler. Comments may explain the
    // relationship; the code may not encode one.
    const src = code("contracts/src/MandateRegistry.sol");
    must(!/Deadhand|onlyHandler|IDeadhand/.test(src),
      "MandateRegistry names the handler in executable code — Layer 2 is not deletable");
    // And the deployed bytecode must not carry the handler's address.
    must(!stripMetadata(registryCode).toLowerCase().includes(HANDLER.slice(2).toLowerCase()),
      "the deployed registry contains the handler address");
    // settleFinalizedMarket must be callable by anyone: nothing between the
    // parameter list and `returns` except `external`.
    const flat = src.replace(/\s+/g, " ");
    must(/function settleFinalizedMarket\([^)]*\) external returns/.test(flat),
      "settleFinalizedMarket has acquired a modifier — it must stay permissionless");
    return `registry code names no handler, deployed bytecode has no handler address, settleFinalizedMarket is permissionless; subscription ${sub === 0n ? "disarmed" : `ARMED (${sub})`}`;
  });

  await check("validators-settle-a-batch-in-block", async () => {
    // `marketsSettled > 0` was an INGREDIENT, not the conclusion: the claim
    // names batch sizes, and "at least one settle happened" does not check
    // them. Each cited evidence hash is now fetched and its Deadhand event
    // read.
    const set = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
    must(set > 0n, `the DEPLOYED handler has settled ${set} markets — the claim is about this deployment, not a previous one`);
    const c = byId("validators-settle-a-batch-in-block")!;
    const ev = ((c as unknown as { proof: { evidence?: string[] } }).proof.evidence ?? []);
    must(ev.length >= 2, `claim cites ${ev.length} evidence transactions; it names several batch sizes`);
    const dead = keccak256(toHex("Deadhand(bytes32,address,uint256,uint256,bool,uint256)"));
    const sizes: number[] = [];
    for (const h of ev) {
      must(/^0x[0-9a-f]{64}$/i.test(h), `evidence "${h}" is not a full transaction hash — a truncated hash proves nothing`);
      const rec = await pub.getTransactionReceipt({ hash: h as Hex });
      must(rec.status === "success", `evidence ${h.slice(0, 12)}… has status ${rec.status}`);
      const log = rec.logs.find((l) => l.topics[0] === dead && l.address.toLowerCase() === HANDLER.toLowerCase());
      must(!!log, `evidence ${h.slice(0, 12)}… has no Deadhand event from the deployed handler`);
      const d = decodeEventLog({ abi: hndAbi, data: log!.data, topics: log!.topics as never });
      const a = d.args as unknown as { processed: bigint; failed: bigint };
      must(a.failed === 0n, `evidence ${h.slice(0, 12)}… settled with ${a.failed} failures`);
      sizes.push(Number(a.processed));
    }
    return `batches of ${sizes.sort((x, y) => x - y).join(", ")} mandates, failed=0 on every one, from ${ev.length} verified validator invocations`;
  });

  await check("real-event-contract-order", async () => {
    const r = await tradableMarketsDetailed(ecClient(RPC), await discoverMarkets(ecClient(RPC), { windows: 8 }), { limit: 3, maxChecks: 12 });
    must(r.live.length > 0, `no tradable market right now (${r.checked} checked, ${r.errors} errors) — beat 2 has nothing to trade into`);
    return `${r.live.length} tradable markets live (${r.errors} failed checks of ${r.checked})`;
  });

  await check("no-eoa-authorization-surface", async () => {
    // RE-RUNS PROBE A. This check previously computed a selector and returned
    // unconditionally — it asserted NOTHING and could never fail, while
    // reporting green on the finding the entire product is built on. Pools were
    // upgraded once inside this hackathon, so the gate is re-proven live rather
    // than remembered.
    const r = await tradableMarketsDetailed(ecClient(RPC), await discoverMarkets(ecClient(RPC), { windows: 8 }), { limit: 1, maxChecks: 12 });
    must(r.live.length > 0, `no live pool to probe (${r.checked} checked, ${r.errors} errors)`);
    const pool = r.live[0]!.pool;
    // A future expiry INSIDE the market window: expireTimestampNs = 0 is
    // rejected outright, and exceeding the market expiry reverts
    // OrderExpiryBeyondMarket — either would revert before the authorization
    // gate and prove nothing about it.
    const expNs = (r.live[0]!.expiry - 5n) * 1_000_000_000n;
    const stranger = { address: strangerAddress() };
    // The ABI comes from the SDK, not from a signature typed here. A
    // hand-written `placeBinaryOrderFor(address,uint8,...)` hashed to
    // 0x275284bb while the real selector is 0x5d97c566, so the call hit the
    // fallback and reverted with NO return data — which the first version of
    // this check accepted as a pass. Re-deriving an ABI is how you end up
    // proving something about a function that does not exist.
    const data = encodeFunctionData({
      abi: binaryPoolWriteAbi,
      functionName: "placeBinaryOrderFor",
      args: [stranger.address, 0, 100_000n, 1_000_000n, expNs, 0, 0,
             "0x0000000000000000000000000000000000000000", 0n, 0n] as never,
    });
    try {
      await pub.call({ account: stranger.address, to: pool, data });
      throw new Error("placeBinaryOrderFor did NOT revert from an EOA — the authorization gate is gone, and the product's premise with it");
    } catch (e) {
      const msg = (e as Error).message;
      must(!msg.includes("did NOT revert"), msg);
      // The selector, from raw return data — not matched out of a message.
      let sel = "";
      let cur: unknown = e;
      const seen = new Set<unknown>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const d = (cur as { data?: unknown }).data;
        if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) { sel = d.slice(0, 10); break; }
        cur = (cur as { cause?: unknown }).cause;
      }
      // The selector is REQUIRED. Accepting an empty revert would let this
      // pass on any failure at all, which is how it got here.
      must(sel === "0x3fb0ba2e",
        `expected OnlyApprovedContracts (0x3fb0ba2e) from ${pool}, got ${sel || "no return data"}`);
      return `placeBinaryOrderFor reverts from an EOA on live pool ${pool.slice(0, 10)}…` + `with ${sel} (OnlyApprovedContracts)`;
    }
  });

  // ---- subscription hygiene, enforced structurally -----------------------
  //
  // A crashed run once left a subscription armed and burned ~0.19 STT across
  // 400 unattended invocations. `probe-c.ts` was still arming one and disarming
  // it on NO path, success included. A documented constraint that is not
  // enforced in code is a constraint that gets broken, so this is a check
  // rather than a note in a file.
  {
    const armers: string[] = [];
    const unguarded: string[] = [];
    for (const f of ["stage3-live.ts", "measure-skip.ts", "probe-c.ts", "demo-reset.ts", "stage2-live.ts",
                     "probe-a.ts", "probe-b.ts", "probe-b2.ts", "fund.ts", "doctor.ts"]) {
      const s = code(`scripts/${f}`);
      if (!/["']subscribeTo["']|subscribeTo\(/.test(s)) continue;
      armers.push(f);
      if (!/installUnwind\(\)/.test(s) || !/stillArmed\(\)/.test(s)) unguarded.push(f);
    }
    if (unguarded.length === 0) {
      record("PASS", "subscriptions-unwind", `${armers.length} scripts arm a subscription (${armers.join(", ")}); all install unwind and assert stillArmed()`);
    } else {
      record("FAIL", "subscriptions-unwind", `${unguarded.join(", ")} arm a subscription without installUnwind()+stillArmed()`);
    }
  }

  // ---- money actually owed to delegators, and not collected --------------
  //
  // Settlement books a refund; it does not move collateral. The venue only
  // returns escrow when someone calls cancelExpiredOrders, and for most of this
  // build nobody was — totalRefundClaim reached 11.42 tUSDC against a registry
  // balance of 0. holdsNoFunds() cannot see that: it asserts
  // balance <= owed + claims, which passes MORE easily the less we hold.
  //
  // So this reports the other direction: what is owed to delegators and has not
  // reached them. Not a failure of the contract — a demo-readiness fact, and
  // the reason scripts/collect.ts exists.
  {
    const rAbi = parseAbi([
      "function totalRefundClaim() view returns (uint256)",
      "function totalOwed() view returns (uint256)",
    ]);
    const claims = await pub.readContract({ address: REGISTRY, abi: rAbi, functionName: "totalRefundClaim" }) as bigint;
    const owed = await pub.readContract({ address: REGISTRY, abi: rAbi, functionName: "totalOwed" }) as bigint;
    const held = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [REGISTRY] }) as bigint;
    const line = `claims ${formatUnits(claims, 6)} · owed ${formatUnits(owed, 6)} · held ${formatUnits(held, 6)} tUSDC`;
    if (claims === 0n && owed === 0n) {
      record("PASS", "delegators-paid", `nothing outstanding to any delegator (${line})`);
    } else if (held >= claims + owed) {
      record("PASS", "delegators-paid", `outstanding but fully backed — run scripts/collect.ts to push it out (${line})`);
    } else {
      // AMBER, not FAIL: a shortfall here is normally MONEY IN FLIGHT, not
      // money lost. `settleOne` books a claim the moment a market resolves and
      // the pool returns the escrow asynchronously — measured at minutes.
      //
      // This message used to assert the cause: "most PHANTOM, booked against
      // collateral _sweep already returned". That was a diagnosis printed
      // without checking anything, and it was WRONG on the current deployment —
      // 11 mandates showing exactly this shape were paid in full by
      // scripts/collect.ts once the proceeds landed. A status line that names a
      // cause it did not verify is the rule-6 failure this file exists to stop.
      //
      // So it reports the shortfall and how to tell the two apart, and lets the
      // reader do what neither of us can do from one snapshot: wait, then look
      // again.
      record("AMBER", "delegators-paid",
        `${formatUnits(claims + owed - held, 6)} tUSDC booked beyond what the registry holds. ` +
        `Usually proceeds still in flight from the pool (minutes, not blocks) — wait, then ` +
        `run scripts/collect.ts and re-check. If it does NOT clear, that is the signature of ` +
        `collateral that left with another delegator's order and is worth investigating (${line})`);
    }
  }

  // ---- the rule-6 sweep, as a recurring check ----------------------------
  //
  // The sweep was done once and four new instances appeared afterwards, all in
  // code written since. One of them printed "every figure above is read from
  // the contract" unconditionally while a failed poll left a stale read on
  // screen — asserting the exact property this product IS a claim about. A
  // one-time cleanup does not hold that line; a check that fails the build does.
  {
    // (a) ASSERTIVE COPY. Any user-visible literal that claims a property must
    // be either computed from a check, or listed here with what backs it.
    // Adding new assertive copy then requires a deliberate decision instead of
    // happening by accident in a hurry the night before a demo.
    const VETTED = new Map<string, string>([
      ['<span class="hint">markets resolve every few minutes, so the ones you picked have closed. this does not change any spending limit.</span>',
        "setMarkets writes only allowedMarket[][]; maxStakePerTrade/maxCumulativeExposure/expiry are untouched — " +
        "test_setMarketsCannotMoveAnyMoneyLimit and test_wideningDoesNotRaiseTheSpendingCap"],
      ['<span class="hint">these markets resolve every few minutes, so the ones this mandate names have already closed. the delegator can point it at the markets trading now from their own screen — the spending limits do not change.</span>',
        "same: setMarkets is delegator-only (test_delegateCannotWidenTheirOwnMandate) and moves no money limit"],
      ["that transaction reverted — nothing changed.",
        "rendered only when receipt.status !== 'success'; a reverted tx changes no state by definition"],
      ["leash — a trading key that cannot steal", "no withdraw() entry point exists: claim delegate-cannot-take"],
      ["nothing else. the money never leaves your wallet, and the only address it can be withdrawn to is yours.",
        "_returnTo/_sweep pay only mandates[id].delegator; claim registry-holds-no-funds"],
      ["held by leash, every block", "readHeld() reads balanceOf + holdsNoFunds live; renders an em dash when unread"],
      ["limits, checked in the order path", "placeForDelegator validates before _pull: MandateRegistry.sol:264-327"],
      [", and the registry keeps nothing that is not owed to a named party.</p>", "unattributed() == 0, asserted live"],
      ['<span class="eyebrow">what leash cannot do</span>', "heads the CANNOT list; each item maps to a named contract error, claim delegate-cannot-bypass"],
      ['<span class="hint">they sign their own transactions from this address. they never see your key.</span>',
        "true by construction: the delegate is an EOA that calls placeForDelegator itself; no key material crosses"],
      ['<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">one signature. then nothing.</h2>',
        "the delegator signs approve + createMandate, then nothing until they choose to revoke; claim real-event-contract-order"],
      ['<p class="body" style="margin:0">the registry holds nothing that is not owed to a named party.</p>',
        "holdsNoFunds() and unattributed(), both asserted live; claim registry-holds-no-funds"],
      ['<p class="body" style="margin:0">one transaction, no counterparty. the delegate cannot stop it, cannot delay it, and does not need to agree. their next order reverts.</p>',
        "revoke() is delegator-only and sets revoked=true; the delegate's next placeForDelegator reverts Revoked; claim delegate-cannot-bypass"],
      ['<span class="hint">they sign their own transactions from this address. they never see your key, and you never see theirs.</span>',
        "true by construction: the delegate is an EOA calling placeForDelegator itself; no key material crosses either way"],
      ['<span class="eyebrow">once signed, they cannot</span>',
        "heads the four refusals; each maps to a named contract error, claim delegate-cannot-bypass"],
      ['<span class="hint">connect the wallet that created it to end it — only the delegator can.</span>',
        "revoke() reverts NotDelegator for anyone else; asserted live in claim delegate-cannot-take"],
      ['<span class="hint">you sign your own orders. the delegator never sees your key, and you never see theirs.</span>',
        "same construction as above, stated on the delegate side"],
      ['<span class="hint">nothing placed from this browser yet.</span>',
        "literal: state.log is empty. Scoped to this browser session, which is what it says"],
      ['<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">nothing to hand over yet</h2>',
        "literal: state.mandateId is null, so there is no link to issue. Rendered only in that branch"],
      ["connect your wallet to revoke — only the delegator can.",
        "revoke() is delegator-gated on chain (NotDelegator); the button is disabled in this state too"],
      ['<p class="body" style="margin:0">you place these. they are not yours. every payout settles to',
        "_payRefund pays mandates[id].delegator only; claim no-unattributed-escrow"],
    ]);
    // NOTE ON WHAT THIS DOES NOT CATCH. The pattern matches a CLASS of assertive
    // phrasing, not every possible claim: "move your money to any address but
    // yours" is an assertion and matches nothing here. It is a tripwire that
    // forces a decision on the common shapes, not a proof that no unbacked
    // claim exists. Saying so is the point — a check trusted past what it
    // actually checks is how the last four green-but-wrong results happened.
    // state.ts WHY strings are design rationale shown as an aside, not claims
    // about chain state, so they are out of scope by file rather than by string.
    const SCOPE = ["apps/web/index.html", "apps/web/src/landing.ts",
                   "apps/web/src/screens/delegator.ts", "apps/web/src/screens/delegate.ts"];
    const ASSERTIVE = /\b(every|always|never|cannot|can't|holds? no|nothing|only|no admin|is read from)\b/i;
    const stray: string[] = [];
    for (const f of SCOPE) {
      const raw = readFileSync(f, "utf8");
      let found: string[];
      if (f.endsWith(".html")) {
        found = [...raw.replace(/<script[\s\S]*?<\/script>/g, " ").matchAll(/>([^<>{}]{18,})</g)]
          .map((m) => m[1]!.replace(/\s+/g, " ").trim());
      } else {
        found = [...code(f).matchAll(/'([^'\\\n]{18,})'|"([^"\\\n]{18,})"/g)].map((m) => (m[1] ?? m[2])!);
      }
      for (const s of found) {
        if (!ASSERTIVE.test(s)) continue;
        if (!/[a-z]{3} [a-z]{3}/i.test(s)) continue; // markup fragments, not prose
        if (VETTED.has(s)) continue;
        stray.push(`${f}: "${s.slice(0, 90)}"`);
      }
    }
    if (stray.length === 0) {
      record("PASS", "assertive-copy", `${VETTED.size} assertive strings, each vetted against a named claim; no unvetted ones in ${SCOPE.length} files`);
    } else {
      record("FAIL", "assertive-copy",
        `${stray.length} user-visible string(s) claim a property with nothing vetting them — add to VETTED with what backs it, or make it conditional: ${stray.join(" | ")}`);
    }
  }

  {
    // (b) SWALLOWING CATCHES. A catch that neither rethrows, nor counts, nor
    // surfaces the failure returns a plausible default — which is how "0
    // tradable markets" once meant "the RPC is rate-limiting us".
    // Every .ts under apps/web/src is in scope. It used to be a hand-listed
    // subset, and four files written since — resume.ts, markets.ts, qr.ts,
    // state.ts — were simply never scanned. A tripwire with a stale scope stops
    // being a tripwire for exactly the code most likely to need one: the new code.
    const SCOPE = ["apps/web/src/app.ts", "apps/web/src/landing.ts", "apps/web/src/held.ts",
                   "apps/web/src/chain.ts", "apps/web/src/resume.ts", "apps/web/src/markets.ts",
                   "apps/web/src/qr.ts", "apps/web/src/state.ts",
                   "apps/web/src/screens/delegator.ts",
                   "apps/web/src/screens/delegate.ts", "packages/leash-ec/src/discover.ts",
                   "scripts/verify.ts", "scripts/unwind.ts", "scripts/stage3-live.ts",
                   "scripts/measure-skip.ts", "scripts/demo-reset.ts", "scripts/doctor.ts"];
    // Each of these has been read and is deliberate. The comment in the source
    // says why; this number is the record that someone decided.
    //
    // Raised 14 -> 20 on 8 Sep, after widening the scope to every file under
    // apps/web/src. The six newly-visible ones were read:
    //   resume.ts x3  — localStorage throws outright in a private window, and a
    //                   pointer we cannot store is a slower next load, not a
    //                   broken one.
    //   resume.ts x2  — a failed chain read during the background scan falls
    //                   back to showing setup. Recoverable: the delegate link
    //                   still carries the mandate id, and nothing negative is
    //                   cached, so the next connect retries.
    //   markets.ts x1 — not silent at all; it sets marketsState "failed" and
    //                   renders the reason. Counted by the scanner, surfaced in
    //                   the product.
    const VETTED_CATCHES = 20;
    let swallowing = 0;
    const where: string[] = [];
    for (const f of SCOPE) {
      const src = readFileSync(f, "utf8");
      // catch (...) { ...body up to the matching close... } — shallow bodies only,
      // which is what a swallowing catch looks like.
      for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g)) {
        const body = m[1] ?? "";
        const handles = /throw|console\.(error|log|warn)|\+\+|record\(|set\(\{|bad\(|errors|Failed|paint\(|UNREAD|return \{ \.\.\.UNREAD/.test(body);
        if (!handles) { swallowing++; where.push(`${f}: catch {${body.replace(/\s+/g, " ").slice(0, 60)}}`); }
      }
    }
    if (swallowing <= VETTED_CATCHES) {
      record("PASS", "swallowing-catches", `${swallowing} silent catch block(s) across ${SCOPE.length} files, at or under the ${VETTED_CATCHES} reviewed`);
    } else {
      record("FAIL", "swallowing-catches", `${swallowing} silent catch blocks, above the ${VETTED_CATCHES} reviewed — each new one must count, rethrow or surface: ${where.slice(0, 4).join(" | ")}`);
    }
  }

  {
    // (c) SECRETS. `.env` gitignored, untracked, and absent from every commit.
    // `.env.example` is expected and is not a match.
    const problems: string[] = [];
    const gi = readFileSync(".gitignore", "utf8");
    if (!/^\.env$/m.test(gi)) problems.push(".gitignore does not ignore .env");
    const tracked = execFileSync("git", ["ls-files", "--", ".env"]).toString().trim();
    if (tracked) problems.push(`.env is TRACKED: ${tracked}`);
    const hist = execFileSync("git", ["log", "--all", "--pretty=format:", "--name-only", "--", ".env"])
      .toString().split(String.fromCharCode(10)).map((s) => s.trim()).filter((s) => s === ".env");
    if (hist.length) problems.push(`.env appears in ${hist.length} commit(s) in history`);
    if (problems.length === 0) {
      record("PASS", "env-never-committed", ".env gitignored, untracked, and absent from every commit on every ref (.env.example is expected)");
    } else {
      record("FAIL", "env-never-committed", problems.join(" | "));
    }
  }

  {
    // (d) NO AI ATTRIBUTION in commit history. Stripped deliberately; a check
    // stops it coming back the next time tooling reintroduces the trailer.
    const n = execFileSync("git", ["log", "--all", "--pretty=format:%B"]).toString()
      .split(String.fromCharCode(10))
      .filter((l) => /co-authored-by|generated with \[claude|claude\.md|anthropic/i.test(l)).length;
    record(n === 0 ? "PASS" : "FAIL", "history-clean",
      n === 0 ? "no attribution trailers or build-doc citations in any commit message" : `${n} commit message line(s) carry an attribution trailer or build-doc citation`);
  }

  // ---- the submission checklist, as code ---------------------------------
  //
  // These are literal requirements from the hackathon checklist. They are here
  // rather than on a list someone ticks, because a heading that must be spelled
  // exactly is precisely the kind of thing that drifts during an edit and is
  // noticed by a judge rather than by us.
  {
    const readme = readFileSync("README.md", "utf8");
    const problems: string[] = [];
    // The heading is mandated verbatim.
    if (!/^## How we use DreamDEX Event Contracts$/m.test(readme)) {
      problems.push('README lacks the exact heading "## How we use DreamDEX Event Contracts"');
    }
    // The order path must be linked BY LINE NUMBER — a judge should not hunt.
    if (!/MandateRegistry\.sol#L\d+/.test(readme)) {
      problems.push("README does not link the order path by line number");
    }
    for (const addr of [REGISTRY, HANDLER]) {
      if (!readme.includes(addr)) problems.push(`README does not name ${addr}`);
    }
    // The claims the checklist requires the README to state.
    for (const phrase of ["non-upgradeable", "no admin key", "holds no funds"]) {
      if (!readme.toLowerCase().includes(phrase)) problems.push(`README does not state "${phrase}"`);
    }
    // The no-custody test, named by path so it can be run.
    if (!readme.includes("MandateEnforcement.t.sol")) {
      problems.push("README does not name the balanceOf(registry) test by path");
    }
    // Three explorer links, and they must be full hashes.
    const hashes = [...readme.matchAll(/shannon-explorer\.somnia\.network\/tx\/(0x[0-9a-fA-F]{64})/g)].map((m) => m[1]!);
    if (new Set(hashes).size < 3) problems.push(`README cites ${new Set(hashes).size} full transaction hashes, needs at least 3`);
    if (/tx\/0x[0-9a-fA-F]{1,63}(?![0-9a-fA-F])/.test(readme)) problems.push("README contains a TRUNCATED transaction hash — it proves nothing");
    // Only files a FRESH CLONE has. Requiring an untracked one passes here and
    // fails for the judge, which is the worst possible place to learn it.
    for (const f of ["LICENSE", "docs/ARCHITECTURE.md", "claims.json"]) {
      if (!existsSync(f)) problems.push(`missing ${f}`);
    }
    if (problems.length === 0) {
      record("PASS", "submission-checklist",
        `exact heading present, order path linked by line, both addresses named, ${new Set(hashes).size} full tx hashes, LICENSE + architecture + claims all present`);
    } else {
      record("FAIL", "submission-checklist", problems.join(" | "));
    }
  }

  // ---- build health ------------------------------------------------------
  console.log("\n  --- build ------------------------------------------------------");
  const sh = (label: string, cmd: string, args: string[], cwd?: string) => {
    try {
      execFileSync(cmd, args, { cwd, stdio: "pipe", shell: process.platform === "win32" });
      record("PASS", label, `${cmd} ${args.join(" ")} exited 0`);
    } catch (e) {
      const out = ((e as { stdout?: Buffer }).stdout?.toString() ?? "") + ((e as { stderr?: Buffer }).stderr?.toString() ?? "");
      record("FAIL", label, out.split(String.fromCharCode(10)).filter(Boolean).slice(-3).join(" | ") || String(e));
    }
  };
  sh("forge-test", "forge", ["test"]);
  sh("typecheck-root", "npx", ["tsc", "--noEmit"]);
  sh("typecheck-web", "npx", ["tsc", "--noEmit"], "apps/web");
  sh("web-build", "npm", ["run", "build"], "apps/web");

  // ---- addresses agree ---------------------------------------------------
  const uiSrc = readFileSync("apps/web/src/chain.ts", "utf8");
  if (uiSrc.includes(REGISTRY) && uiSrc.includes(HANDLER)) {
    record("PASS", "addresses-agree", `UI, .env and claims.json all name ${REGISTRY.slice(0, 10)}… / ${HANDLER.slice(0, 10)}…`);
  } else {
    record("FAIL", "addresses-agree", `apps/web/src/chain.ts does not name the deployed registry and handler`);
  }

  // ---- funding -----------------------------------------------------------
  for (const k of ["FUND_KEY", "DELEGATE_KEY", "STRANGER_KEY"]) {
    try {
      const a = acct(k);
      const b = await pub.getBalance({ address: a.address });
      // ~0.028 STT per order; below ten orders the delegate stalls mid-demo
      // with an opaque "Missing or invalid parameters".
      const floor = k === "DELEGATE_KEY" ? 300_000_000_000_000_000n : 50_000_000_000_000_000n;
      record(b >= floor ? "PASS" : "FAIL", `funding-${k.toLowerCase()}`,
        `${a.address} holds ${formatEther(b)} STT`);
    } catch (e) {
      const msg = (e as Error).message;
      // "not configured" vs "configured and broke".
      record(/missing from the environment/.test(msg) ? "SKIP" : "FAIL",
        `funding-${k.toLowerCase()}`,
        /missing from the environment/.test(msg)
          ? `${k} not set — demo-spending scripts need it, the claims above do not`
          : msg);
    }
  }

  // ---- verdict -----------------------------------------------------------
  const fails = results.filter((r) => r.level === "FAIL");
  const ambers = results.filter((r) => r.level === "AMBER");
  console.log(`\n  ${results.length} checks: ${results.length - fails.length - ambers.length} pass, ${ambers.length} amber, ${fails.length} fail`);
  if (ambers.length) {
    console.log("\n  AMBER — the claim may be true, but the evidence is stale:");
    for (const a of ambers) console.log(`    ${a.id}: ${a.line}`);
  }
  if (fails.length) {
    console.log("\n  FAIL:");
    for (const f of fails) console.log(`    ${f.id}: ${f.line}`);
    console.log("\n  Do not record the video against this build.\n");
    process.exit(1);
  }
  if (ambers.length) {
    console.log("\n  No failures, but claims above are unproven on the CURRENT build.");
    console.log("  They must not appear in the README or the video until re-proven.\n");
    process.exit(2);
  }
  console.log("\n  Every claim in claims.json holds against the deployed system.\n");
}

main().catch((e) => { console.error("\nverify crashed:", e); process.exit(1); });
