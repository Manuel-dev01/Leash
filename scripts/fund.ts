/**
 * Top up the delegate and stranger wallets from the fund key.
 *
 * Gas on Somnia is ~6 gwei, so an order costs ~0.0024 STT and a revert far
 * less. These wallets need very little — the point of keeping them thin is that
 * the delegate visibly holds no capital, which is the whole claim.
 *
 * Idempotent: tops up to a target, skips anything already above it.
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.RPC_URL ?? NETWORK.rpc;
const chain = {
  id: NETWORK.chainId,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pk = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} not set in .env`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`);
};

const TARGETS: [string, string][] = [
  ["DELEGATE_KEY", "0.5"],
  ["STRANGER_KEY", "0.5"],
];

async function main() {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const fund = pk("FUND_KEY");
  const wallet = createWalletClient({ account: fund, chain, transport: http(RPC) });

  console.log(`\nfunding from ${fund.address}`);
  console.log(`balance ${formatEther(await pub.getBalance({ address: fund.address }))} STT\n`);

  for (const [name, target] of TARGETS) {
    const acct = pk(name);
    const bal = await pub.getBalance({ address: acct.address });
    const want = parseEther(target);
    if (bal >= want) {
      console.log(`  skip  ${name} ${acct.address} already ${formatEther(bal)} STT`);
      continue;
    }
    const top = want - bal;
    const hash = await wallet.sendTransaction({ to: acct.address, value: top });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(
      `  sent  ${name} ${acct.address} +${formatEther(top)} STT  ` +
        `status=${rcpt.status}  ${NETWORK.explorer}/tx/${hash}`,
    );
  }

  console.log(`\nfund key now ${formatEther(await pub.getBalance({ address: fund.address }))} STT\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
