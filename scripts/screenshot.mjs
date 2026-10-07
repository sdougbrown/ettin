/**
 * Dev helper: screenshot the room UI with Playwright's chromium.
 * Usage: node scripts/screenshot.mjs [url] [outfile]
 * Assumes the room is running (npm start) and a playwright chromium under
 * ~/.cache/ms-playwright (any version).
 */
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const url = process.argv[2] ?? "http://localhost:7947";
const out = process.argv[3] ?? "/tmp/ettin-ui.png";
const exe = execSync("ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1")
  .toString()
  .trim();
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
