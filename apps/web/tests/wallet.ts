import type { Page } from "@playwright/test";

/**
 * A minimal EIP-1193 provider injected before any page script runs.
 *
 * The app reads `window.ethereum` fresh on every call (chain.ts `eth()`), never
 * subscribes to events and never uses EIP-6963, so this is enough to unlock
 * every account-gated path.
 *
 * READ-ONLY BY DESIGN. It answers the identity and chain questions and REFUSES
 * to sign. Nothing here fabricates chain state: every figure the app displays
 * still comes from the real registry over the real RPC. A stub that invented
 * balances would make the sweep prove nothing, which is the opposite of the
 * point — the whole product is a claim about what the chain says.
 */
export const DELEGATOR = "0xBCA6f82e240C6AC36B23b4f7D21adF17e03966Fe";
export const DELEGATE = "0x5b92F8A222704d522Fb3dCf8d734C3DAF51Fc4f1";

export async function injectWallet(page: Page, account: string, chainIdHex = "0xc488") {
  await page.addInitScript(
    ({ account, chainIdHex }) => {
      const calls: { method: string; params?: unknown[] }[] = [];
      (window as unknown as { __walletCalls: typeof calls }).__walletCalls = calls;
      (window as unknown as { ethereum: unknown }).ethereum = {
        isMetaMask: true,
        async request(args: { method: string; params?: unknown[] }) {
          calls.push({ method: args.method, params: args.params });
          switch (args.method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [account];
            case "eth_chainId":
              return chainIdHex;
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "eth_sendTransaction":
            case "eth_signTypedData_v4":
            case "personal_sign":
              // Refuse exactly as a user declining in their wallet would, so the
              // app's own error path is what gets exercised.
              throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            default:
              throw Object.assign(new Error(`unstubbed method ${args.method}`), { code: 4200 });
          }
        },
        on() {},
        removeListener() {},
      };
    },
    { account, chainIdHex },
  );
}

/** A wallet that is present but on the wrong chain — a very common real state. */
export async function injectWrongChainWallet(page: Page, account: string) {
  await injectWallet(page, account, "0x1");
}
