import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { injectWallet, injectWrongChainWallet, DELEGATOR, DELEGATE } from "./wallet.js";
import { mkdirSync } from "node:fs";

const SHOTS = ".artifacts/sweep";
mkdirSync(SHOTS, { recursive: true });

/**
 * Strings that mean "still working". If one of these is still on screen after
 * the grace period, the user is looking at a state that never resolves — the
 * single most common defect in this app. Every one of these was found sitting
 * on a screen permanently.
 */
const NEVER_RESOLVES = [
  "reading live markets from chain",
  "reading the mandate",
  "reading chain",
];

/** How long a real RPC round-trip set is allowed to take before we call it stuck. */
const GRACE_MS = 25_000;

interface Problems {
  console: string[];
  pageerrors: string[];
}

function watch(page: Page): Problems {
  const p: Problems = { console: [], pageerrors: [] };
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") p.console.push(m.text());
  });
  page.on("pageerror", (e) => p.pageerrors.push(e.message));
  return p;
}

/**
 * Horizontal overflow, measured on the real layout rather than guessed at.
 *
 * Elements inside a clipping ancestor are NOT offenders. The landing ticker is
 * deliberately `width:max-content` and far wider than the viewport, contained
 * by a parent with `overflow:hidden` — counting it would have had me "fix" a
 * marquee that works exactly as intended.
 */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const clipped = (el: HTMLElement) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "hidden" || ov === "clip" || ov === "auto" || ov === "scroll") return true;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right <= window.innerWidth + 1) continue;
      if (clipped(el)) continue;
      wide.push(
        `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}` +
        `${el.className ? "." + String(el.className).split(" ")[0] : ""} ` +
        `right=${Math.round(r.right)} w=${Math.round(r.width)}`,
      );
    }
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflows: doc.scrollWidth > doc.clientWidth + 1,
      offenders: wide.slice(0, 8),
    };
  });
}

async function stuck(page: Page) {
  const body = (await page.locator("body").innerText()).toLowerCase();
  return NEVER_RESOLVES.filter((s) => body.includes(s));
}

async function shot(page: Page, name: string, project: string) {
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

const DELEGATOR_SCREENS = ["connect", "pick", "limits", "review", "issue", "monitor", "revoke"] as const;
const DELEGATE_SCREENS = ["trade", "market", "positions"] as const;

test.describe("landing", () => {
  test("renders, resolves its live stat, and has no overflow", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/index.html");
    await expect(page.locator("h1")).toContainText("cannot");

    // The headline stat starts as "…" and must become a real figure or an em
    // dash. Staying "…" means the read never completed and nothing said so.
    await expect
      .poll(async () => (await page.locator("#stats").innerText()).includes("…"), { timeout: GRACE_MS })
      .toBe(false);

    const held = await page.locator("#stats").innerText();
    expect(held, "held stat must be a number or an em dash, never blank").toMatch(/[0-9]|—/);

    const o = await overflow(page);
    expect(o.offenders, `horizontal overflow: ${JSON.stringify(o.offenders)}`).toEqual([]);
    expect(o.overflows).toBe(false);

    await shot(page, "landing", info.project.name);
    expect(p.pageerrors, "page errors").toEqual([]);
    expect(p.console, "console errors").toEqual([]);
  });

  test("add-network button reports and recovers", async ({ page }, info) => {
    await injectWallet(page, DELEGATOR);
    await page.goto("/index.html");
    const btn = page.locator("#addnet");
    const before = (await btn.innerText()).trim();
    await btn.click();
    await page.waitForTimeout(600);
    const after = (await btn.innerText()).trim();
    expect(after, "the button must say something after being pressed").not.toBe("");
    await shot(page, "landing-addnet", info.project.name);
    // It must RECOVER. A button that permanently relabels itself with the last
    // error has lost its affordance: the only CTA on the landing page ends up
    // reading "No wallet found" with nothing telling the user it is still a
    // button. Give it a moment, then require the label back.
    await expect
      .poll(async () => (await btn.innerText()).trim(), { timeout: 8_000 })
      .toBe(before);
  });
});

test.describe("app — no wallet", () => {
  test("every screen renders, none is stuck, none overflows", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);

    for (const screen of DELEGATOR_SCREENS) {
      await page.locator(`[data-go="${screen}"]`).click();
      await page.waitForTimeout(400);
      const s = await stuck(page);
      expect(s, `delegator/${screen} stuck on: ${s.join(", ")}`).toEqual([]);
      const o = await overflow(page);
      expect(o.offenders, `delegator/${screen} overflow: ${JSON.stringify(o.offenders)}`).toEqual([]);
      await shot(page, `delegator-${screen}`, info.project.name);
    }

    await page.locator("#tab-delegate").click();
    await page.waitForTimeout(600);
    for (const screen of DELEGATE_SCREENS) {
      await page.locator(`[data-go="${screen}"]`).click();
      await page.waitForTimeout(400);
      const s = await stuck(page);
      expect(s, `delegate/${screen} stuck on: ${s.join(", ")}`).toEqual([]);
      const o = await overflow(page);
      expect(o.offenders, `delegate/${screen} overflow: ${JSON.stringify(o.offenders)}`).toEqual([]);
      await shot(page, `delegate-${screen}`, info.project.name);
    }

    expect(p.pageerrors, "page errors").toEqual([]);
    expect(p.console, "console errors").toEqual([]);
  });

  test("no control is dead: every enabled button says or does something", async ({ page }) => {
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);
    const dead: string[] = [];

    for (const screen of [...DELEGATOR_SCREENS, ...DELEGATE_SCREENS]) {
      const nav = page.locator(`[data-go="${screen}"]`);
      if (!(await nav.count())) continue;
      await nav.click();
      await page.waitForTimeout(300);

      const buttons = page.locator("#screen button:enabled");
      const n = await buttons.count();
      for (let i = 0; i < n; i++) {
        const b = buttons.nth(i);
        const label = (await b.innerText()).trim().slice(0, 30);
        const before = await page.locator("#screen").innerText();
        await b.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(500);
        const after = await page.locator("#screen").innerText();
        if (before === after) dead.push(`${screen} › "${label}"`);
        // Return to the screen under test in case the click navigated.
        const back = page.locator(`[data-go="${screen}"]`);
        if (await back.count()) { await back.click(); await page.waitForTimeout(200); }
      }
    }
    expect(dead, `enabled controls that produced no visible change: ${dead.join(" | ")}`).toEqual([]);
  });
});

test.describe("app — wallet present", () => {
  test("connect advances and the chain chip reflects the network", async ({ page }, info) => {
    const p = watch(page);
    await injectWallet(page, DELEGATOR);
    await page.goto("/app.html");
    await page.waitForTimeout(2_000);

    await expect(page.locator("#chip")).toContainText(/ready/i, { timeout: 10_000 });
    await page.locator("#d-connect").click();
    await page.waitForTimeout(1_500);
    // Connecting must move the user forward, not sit on the same screen.
    await expect(page.locator("#screen")).toContainText(/who is trading|delegate_address/i);
    await shot(page, "connected-pick", info.project.name);
    expect(p.pageerrors).toEqual([]);
  });

  test("a wallet on the wrong chain is reported, not ignored", async ({ page }, info) => {
    await injectWrongChainWallet(page, DELEGATOR);
    await page.goto("/app.html");
    await page.waitForTimeout(2_000);
    await expect(page.locator("#chip")).not.toContainText(/ready/i);
    await shot(page, "wrong-chain", info.project.name);
  });

  test("a rejected signature surfaces an error and clears busy", async ({ page }, info) => {
    await injectWallet(page, DELEGATOR);
    await page.goto("/app.html");
    await page.waitForTimeout(2_000);
    await page.locator("#d-connect").click();
    await page.waitForTimeout(1_000);
    await page.locator("#d-addr").fill(DELEGATE);
    await page.locator("#d-next").click();
    await page.waitForTimeout(500);
    await page.locator("[data-go='review']").click();
    await page.waitForTimeout(500);
    const sign = page.locator("#d-sign");
    if (await sign.count()) {
      await sign.click();
      await page.waitForTimeout(3_000);
      // The button must come back — a permanently disabled "signing…" is a
      // dead end with no way out but a reload.
      await expect(sign).toBeEnabled({ timeout: 20_000 });
      await expect(page.locator("#screen")).toContainText(/reject|denied|failed|error/i);
    }
    await shot(page, "rejected-signature", info.project.name);
  });
});

test.describe("negative cases", () => {
  test("a malformed ?m= must not blank the page", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/app.html?m=abc");
    await page.waitForTimeout(3_000);
    const body = (await page.locator("body").innerText()).trim();
    expect(body.length, "page rendered nothing at all").toBeGreaterThan(40);
    await expect(page.locator("#screen")).not.toBeEmpty();
    await shot(page, "bad-mandate-param", info.project.name);
    expect(p.pageerrors, `uncaught: ${p.pageerrors.join(" | ")}`).toEqual([]);
  });

  test("a delegate with no mandate is told so, not left reading", async ({ page }, info) => {
    await page.goto("/app.html?role=delegate");
    await page.waitForTimeout(GRACE_MS);
    const s = await stuck(page);
    expect(s, `delegate landed on a permanent loading state: ${s.join(", ")}`).toEqual([]);
    await shot(page, "delegate-no-mandate", info.project.name);
  });

  test("a dead RPC shows an em dash, never a confident zero", async ({ page }, info) => {
    // The claim this protects is onscreen-figures-are-chain-derived: an
    // unreachable chain must not be indistinguishable from an empty registry.
    await page.route("**/api.infra.testnet.somnia.network/**", (r) => r.abort());
    await page.route("**/dream-rpc.somnia.network/**", (r) => r.abort());
    await page.goto("/index.html");
    await expect
      .poll(async () => (await page.locator("#stats").innerText()).includes("…"), { timeout: GRACE_MS })
      .toBe(false);
    const stats = await page.locator("#stats").innerText();
    expect(stats, "a dead RPC must render an em dash").toContain("—");
    await shot(page, "dead-rpc-landing", info.project.name);
  });

  test("a dead RPC does not leave the app spinning", async ({ page }, info) => {
    await page.route("**/api.infra.testnet.somnia.network/**", (r) => r.abort());
    await page.route("**/dream-rpc.somnia.network/**", (r) => r.abort());
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);
    await page.locator("[data-go='limits']").click();
    await page.waitForTimeout(1_000);
    const s = await stuck(page);
    expect(s, `dead RPC left a permanent loading state: ${s.join(", ")}`).toEqual([]);
    await expect(page.locator("#screen")).toContainText(/could not|failed|unavailable|retry|degraded/i);
    await shot(page, "dead-rpc-app", info.project.name);
  });
});

test.describe("handoff", () => {
  test("the issue screen produces a scannable link for a real mandate", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/app.html?m=61");
    await page.waitForTimeout(4_000);
    await page.locator('[data-go="issue"]').click();
    await page.waitForTimeout(500);

    // The link must carry the mandate and the delegate role, or the person who
    // scans it lands on the delegator flow with no mandate.
    const link = (await page.locator("#d-link").innerText()).trim();
    expect(link).toContain("role=delegate");
    expect(link).toContain("m=61");

    // A QR must actually be drawn — not a caption promising one.
    const svg = page.locator("#screen svg[role='img']");
    await expect(svg).toHaveCount(1);
    const box = await svg.boundingBox();
    expect(box!.width, "QR rendered with no size").toBeGreaterThan(100);

    await expect(page.locator("#d-copy")).toBeEnabled();
    const o = await overflow(page);
    expect(o.offenders, `issue overflow: ${JSON.stringify(o.offenders)}`).toEqual([]);
    await shot(page, "issue-with-mandate", info.project.name);
    expect(p.pageerrors).toEqual([]);
  });

  test("a delegate opening that link sees the mandate, not a spinner", async ({ page }, info) => {
    await page.goto("/app.html?role=delegate&m=61");
    await page.waitForTimeout(GRACE_MS);
    const s = await stuck(page);
    expect(s, `delegate stuck on: ${s.join(", ")}`).toEqual([]);
    await expect(page.locator("#screen")).toContainText(/you may still spend|reading mandate/i);
    await shot(page, "delegate-with-mandate", info.project.name);
  });
});

test.describe("delegate can act without the delegator's screens", () => {
  test("a delegate connects from their own role", async ({ page }, info) => {
    // The delegate's nav has no connect screen. Before this, the ONLY connect
    // control lived on the delegator tab, so a delegate arriving by link could
    // never sign anything without pretending to be the delegator first.
    await injectWallet(page, DELEGATE);
    await page.goto("/app.html?role=delegate&m=61");
    await page.waitForTimeout(6_000);

    const connect = page.locator("#t-connect");
    await expect(connect, "no connect control on the delegate's own screen").toHaveCount(1);
    await connect.click();
    await page.waitForTimeout(1_500);

    // Still in the delegate role, now with an account, and the ticket is live.
    await expect(page.locator("#tab-delegate")).toHaveClass(/on/);
    await expect(page.locator("#screen")).toContainText(/trading as/i);
    await shot(page, "delegate-connected", info.project.name);
  });
});
