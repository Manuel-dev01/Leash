/**
 * Point the whole repo at a new deployment, in one pass.
 *
 * A redeploy touches the frontend, the tests, the README, the checklist, the
 * claims file and `.env`. Doing that by hand is how a stale address survives in
 * exactly one file and is found later by a judge rather than by us — it already
 * took two manual passes and a wrong checksum on the first attempt.
 *
 * Addresses are written in their CHECKSUMMED form, because `verify.ts` and viem
 * both reject a mixed-case address whose checksum does not verify, and a
 * hand-typed one silently will not.
 *
 * ⚠️ It only rewrites WHOLE addresses. A truncated one in prose —
 * `0x7ca9dA7B…23418864`, as the checklist had — does not match and survives a
 * redeploy looking plausible. After running this, grep for the old address's
 * first six characters across *.md and *.ts.
 *
 *   npx tsx scripts/retarget.ts --from-registry 0x… --from-handler 0x…
 *   npx tsx scripts/retarget.ts --from-registry 0x… --from-handler 0x… --write
 *
 * Reads the NEW addresses from `.env`, so update those first (deploy.ts prints
 * the two lines). Dry by default; `--write` performs it.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getAddress, type Address } from "viem";

/** Every file that may name a deployed address. */
const FILES = [
  ".env",
  "apps/web/src/chain.ts",
  "apps/web/tests/qr.spec.ts",
  "apps/web/tests/sweep.spec.ts",
  "CHECKLIST.md",
  "claims.json",
  "docs/adversarial.md",
  // Judge-facing docs. Neither names a deployed address today, but they are the
  // front door and a stale address there is the worst place to have one.
  "docs/ARCHITECTURE.md",
  "docs/DEMO-SCRIPT.md",
  "README.md",
  "DEMO.md",
  "ROADMAP.md",
  "CLAUDE.md",
];

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function main() {
  const write = process.argv.includes("--write");
  const fromRegistry = arg("--from-registry");
  const fromHandler = arg("--from-handler");
  if (!fromRegistry || !fromHandler) {
    throw new Error("need --from-registry 0x… and --from-handler 0x… (the addresses being replaced)");
  }
  const toRegistry = process.env.MANDATE_REGISTRY;
  const toHandler = process.env.DEADHAND_HANDLER;
  if (!toRegistry || !toHandler) throw new Error("MANDATE_REGISTRY / DEADHAND_HANDLER missing from .env");

  // Normalising through viem is the point: it is what catches a checksum typed
  // by hand, which is a bug that only shows up at runtime.
  const pairs: [string, Address][] = [
    [fromRegistry, getAddress(toRegistry as Address)],
    [fromHandler, getAddress(toHandler as Address)],
  ];
  for (const [from] of pairs) getAddress(from as Address); // reject a malformed source too

  let touched = 0;
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    const before = readFileSync(f, "utf8");
    let after = before;
    for (const [from, to] of pairs) {
      after = after.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
    }
    if (after === before) continue;
    const hits = pairs.reduce(
      (n, [from]) => n + (before.match(new RegExp(from, "gi"))?.length ?? 0), 0,
    );
    console.log(`${write ? "rewrote" : "would rewrite"}  ${f}  (${hits} occurrence${hits === 1 ? "" : "s"})`);
    if (write) writeFileSync(f, after);
    touched++;
  }

  console.log(`\n${write ? "updated" : "would update"} ${touched} file(s)`);
  console.log(`  registry -> ${pairs[0]![1]}`);
  console.log(`  handler  -> ${pairs[1]![1]}`);
  if (!write) console.log("\nDRY RUN. Re-run with --write.");
  else console.log("\nNext: npx tsx scripts/verify.ts   (expect handler measurements to go AMBER until re-measured)");
}

main();
