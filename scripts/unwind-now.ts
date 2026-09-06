/**
 * Disarm the subscription. One command, safe to run when nothing is armed.
 *
 * This exists because "arm it for the take, remember to turn it off" is not a
 * plan. An armed subscription costs 0.001747086 STT on every finalization the
 * venue produces — about 15 STT/day — and a crashed run once left one running
 * for 400 invocations before anyone noticed.
 *
 * Retries with backoff, then reads the subscription id back rather than
 * trusting that a mined transaction did what it said.
 */
import "dotenv/config";
import { unwindPersistently, stillArmed } from "./unwind.js";

async function main() {
  const before = await stillArmed();
  if (!before) {
    console.log("\n  nothing armed. Nothing to do.\n");
    return;
  }
  console.log("\n  subscription is ARMED — disarming...");
  const ok = await unwindPersistently();
  if (!ok || (await stillArmed())) {
    throw new Error("STILL ARMED after every attempt. Cancel it by hand NOW — it spends on every finalization.");
  }
  console.log("  disarmed.\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
