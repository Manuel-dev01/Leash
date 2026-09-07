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

/**
 * The delegator's screens are a strictly ordered SETUP plus a manage surface,
 * so the sweep walks them the way a user does rather than jumping by nav id —
 * there is no nav to jump with any more, which was the point.
 */
const SETUP_STEPS = ["setup", "limits", "review", "issue"] as const;

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
  test("content comes before chrome on every viewport", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);

    // The old shell put a role switch, seven numbered nav rows and a paragraph
    // above the screen: the first line of copy started at 601px of an 844px
    // phone viewport. Chrome must not dominate the first screenful.
    const m = await page.evaluate(() => {
      const h = document.querySelector("#screen h2")?.getBoundingClientRect();
      return { headingTop: Math.round(h?.top ?? -1), vh: window.innerHeight };
    });
    expect(m.headingTop, "no heading rendered").toBeGreaterThan(0);
    expect(m.headingTop, `content starts ${m.headingTop}px down a ${m.vh}px viewport`)
      .toBeLessThan(m.vh * 0.35);

    const o = await overflow(page);
    expect(o.offenders, `overflow: ${JSON.stringify(o.offenders)}`).toEqual([]);
    await shot(page, "setup", info.project.name);
    expect(p.pageerrors).toEqual([]);
    expect(p.console).toEqual([]);
  });

  test("designer's notes are not shipped as product copy", async ({ page }) => {
    await page.goto("/app.html");
    await page.waitForTimeout(3_000);
    const body = (await page.locator("body").innerText()).toLowerCase();
    // `why_this_screen` from the design file is rationale ABOUT the design,
    // addressed to whoever reads it. It was rendering on every screen.
    for (const leak of [
      "sells the mechanism, not the brand",
      "why_this_screen",
      "the delegator's screens write the limits",
    ]) {
      expect(body, `internal design note visible to users: "${leak}"`).not.toContain(leak);
    }
  });

  /**
   * The user asked twice for the numbered nav to go, and `01 / place_order`
   * survived on the delegate screen both times because nothing checked. A
   * step number on a one-screen role promises an 02 that does not exist.
   */
  test("no screen numbers itself", async ({ page }) => {
    for (const url of ["/app.html", "/app.html?role=delegate&m=1"]) {
      await page.goto(url);
      await page.waitForTimeout(1_500);
      const text = await page.locator("body").innerText();
      const numbered = text.match(/^\s*0\d\s*[\/·]/m);
      expect(numbered, `numbered screen label on ${url}: ${numbered?.[0]}`).toBeNull();
      // The one legitimate counter is the setup progress, which reads
      // "step N of 4" and belongs to a flow that genuinely has four steps.
      expect(text).not.toMatch(/step 0\d/);
    }
  });

  test("the whole setup flow walks forward and back", async ({ page }, info) => {
    const p = watch(page);
    await injectWallet(page, DELEGATOR);
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);

    await expect(page.locator("#progress")).toContainText(/step 1 of 4/i);
    await page.locator("#d-connect").click();
    await page.waitForTimeout(1_200);
    await page.locator("#d-addr").fill(DELEGATE);
    await page.locator("#d-next").click();
    await page.waitForTimeout(600);
    await expect(page.locator("#progress")).toContainText(/step 2 of 4/i);

    const s2 = await stuck(page);
    expect(s2, `limits stuck on: ${s2.join(", ")}`).toEqual([]);
    await shot(page, "limits", info.project.name);

    // Back must work from every step past the first.
    await page.locator("#p-back").click();
    await page.waitForTimeout(400);
    await expect(page.locator("#progress")).toContainText(/step 1 of 4/i);

    expect(p.pageerrors).toEqual([]);
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
    await page.locator("#d-next").click();          // step 1 -> 2
    await page.waitForTimeout(1_500);
    await page.locator("#d-review").click();        // step 2 -> 3
    await page.waitForTimeout(800);
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
    await injectWallet(page, DELEGATOR);
    await page.goto("/app.html");
    await page.waitForTimeout(GRACE_MS);
    // The market state lives on step 2, so walk there before judging it.
    await page.locator("#d-connect").click();
    await page.waitForTimeout(800);
    await page.locator("#d-addr").fill(DELEGATE);
    await page.locator("#d-next").click();
    await page.waitForTimeout(1_500);
    const s = await stuck(page);
    expect(s, `dead RPC left a permanent loading state: ${s.join(", ")}`).toEqual([]);
    await expect(page.locator("#screen")).toContainText(/could not|failed|unavailable|retry|degraded|not open/i);
    await shot(page, "dead-rpc-app", info.project.name);
  });
});

test.describe("handoff", () => {
  test("the issue screen produces a scannable link for a real mandate", async ({ page }, info) => {
    const p = watch(page);
    await page.goto("/app.html?m=61");
    await page.waitForTimeout(4_000);
    await page.locator("#m-link").click();
    await page.waitForTimeout(600);
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

test.describe("links actually work", () => {
  test("every link has a real destination, and the address IS the link", async ({ page }) => {
    // This test exists because the checklist claimed "footer registry → opens
    // the explorer" and nothing verified it. The href was fine; the AFFORDANCE
    // was not — the element showing the address was a span, and the anchor was
    // a separate dim caption. Reported, correctly, as "not clickable".
    await page.goto("/index.html");
    await page.waitForTimeout(6_000);

    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a")].map((a) => ({
        text: (a.textContent ?? "").trim().slice(0, 40),
        href: a.getAttribute("href") ?? "",
      })));

    expect(links.length, "no links on the landing page").toBeGreaterThan(2);
    const placeholder = links.filter((l) => l.href === "" || l.href === "#");
    expect(placeholder, `links with no destination: ${JSON.stringify(placeholder)}`).toEqual([]);

    // The registry address must be inside the anchor, not beside it.
    const ex = links.find((l) => l.href.includes("shannon-explorer"));
    expect(ex, "no explorer link found").toBeTruthy();
    expect(ex!.href).toContain("0x7ca9dA7Be8C8F8Ca5E1c9821061cD4fc23418864");
    expect(ex!.text, `explorer link reads "${ex!.text}" — the address should be the clickable text`)
      .toMatch(/0x7ca9/i);
  });

  test("the app's explorer links carry real addresses", async ({ page }) => {
    await page.goto("/app.html");
    await page.waitForTimeout(12_000);
    const ctx = await page.evaluate(() =>
      [...document.querySelectorAll("#context a")].map((a) => a.getAttribute("href") ?? ""));
    expect(ctx.length, "context column has no explorer links").toBeGreaterThan(1);
    for (const href of ctx) {
      expect(href).toMatch(/^https:\/\/shannon-explorer\.somnia\.network\/address\/0x[0-9a-fA-F]{40}$/);
    }
  });
});
