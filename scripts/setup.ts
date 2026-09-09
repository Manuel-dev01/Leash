/**
 * One command between `git clone` and a green `verify.ts`.
 *
 * Two things a fresh clone does not have, and neither is obvious from the error
 * it produces:
 *
 *   - `contracts/lib/forge-std` is NOT vendored and there is no submodule, so
 *     `forge test` fails on `import {Test} from "forge-std/Test.sol"`.
 *   - `contracts/out/` is gitignored, so `verify.ts` cannot read the local
 *     artifact it compares the DEPLOYED bytecode against, and reports ENOENT
 *     for a check that is really about the chain.
 *
 * Both were true of this repo's own README until a clone was actually taken and
 * its instructions followed. Idempotent: safe to re-run.
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const FORGE_STD = "contracts/lib/forge-std";

function run(cmd: string) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  console.log("\nLeash setup\n");

  if (existsSync(FORGE_STD)) {
    console.log(`  forge-std present at ${FORGE_STD}`);
  } else {
    // Cloned rather than `forge install`, which wants to add a submodule and
    // fails inside a repo that has none.
    console.log("  forge-std missing — cloning");
    run(`git clone --depth 1 https://github.com/foundry-rs/forge-std ${FORGE_STD}`);
  }

  console.log("\n  building contracts (verify.ts compares deployed bytecode to this)");
  run("forge build");

  // apps/web has its OWN package.json and is not a workspace of the root, so a
  // root `npm install` leaves it empty - and verify.ts type-checks AND builds
  // the web app as two of its 34 checks. Without this a fresh clone reports
  // "'vite' is not recognized" for a check that is really about the UI.
  if (existsSync("apps/web/package.json")) {
    console.log("\n  installing the web app's dependencies");
    run("npm install --prefix apps/web --no-audit --no-fund");
  }

  console.log("\nReady:");
  console.log("  forge test                 56 contract tests, no network");
  console.log("  npx tsx scripts/verify.ts  34 checks against the live deployment\n");
}

main();
