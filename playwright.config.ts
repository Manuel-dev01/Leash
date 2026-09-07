import { defineConfig, devices } from "@playwright/test";

/**
 * Browser sweep for the Leash web app.
 *
 * Serves the built app with `vite preview` rather than the dev server, because
 * that is what the production bundle actually looks like. Note the URLs are
 * `/index.html` and `/app.html`: `cleanUrls` in vercel.json rewrites `/app` on
 * Vercel ONLY, so a sweep written against `/app` would pass locally and be
 * testing a route that does not exist here.
 */
export default defineConfig({
  testDir: "./apps/web/tests",
  outputDir: ".artifacts/pw",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SWEEP_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "off",
  },
  /**
   * Drives the SYSTEM Chrome rather than a downloaded build. The bundled
   * chromium for this Playwright version would not download here (the fetch
   * times out), and system Chrome is both available and closer to what a judge
   * will actually open the app in.
   */
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 390, height: 844 }, isMobile: false } },
  ],
  // Skipped when SWEEP_URL points at a deployed origin.
  webServer: process.env.SWEEP_URL
    ? undefined
    : {
        command: "npm run preview -- --port 4173 --strictPort",
        cwd: "./apps/web",
        url: "http://localhost:4173/index.html",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
