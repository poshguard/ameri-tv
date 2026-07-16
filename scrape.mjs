/**
 * Scrapes ameriautogroup.com's public inventory page into inventory.json.
 *
 * Uses a real headless Chrome (Playwright) because the site sits behind
 * Cloudflare bot protection that blocks plain HTTP clients. Only vehicles
 * currently listed on the website end up in the JSON — when a car sells and
 * drops off the site, it drops off the TV automatically on the next run.
 *
 * Safety guards — on ANY of these the script exits non-zero WITHOUT touching
 * the existing inventory.json, so the TV keeps showing the last good data:
 *   - zero vehicles scraped (site down, layout change, Cloudflare challenge)
 *   - vehicle count dropped more than 40% vs the previous run (partial page
 *     load; set FORCE=1 to override after a genuine large sell-off)
 *   - fewer than 70% of vehicles have a price (selector drift)
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

const INVENTORY_URL = "https://www.ameriautogroup.com/inventory/";
const IMAGE_CDN_HOST = "imagescf.dealercenter.net";
const OUT_FILE = fileURLToPath(new URL("./inventory.json", import.meta.url));
const MAX_PAGES = 10; // pagination guard — site currently fits on one page

async function scrapePage(page) {
  return page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll(".vehicle-container[data-vehicle-id]")
    );
    return cards.map((card) => {
      const text = (sel) => card.querySelector(sel)?.textContent?.trim() ?? null;
      const vin = (card.getAttribute("data-vehicle-id") || "").replace("vehicle-id-", "");
      const img = card.querySelector("img.vehicle-image");
      // First money token only — a "was $X now $Y" sale format must not
      // concatenate into garbage.
      const priceText = text(".vehicle-price-value");
      const priceMatch = priceText ? priceText.match(/\$?\s*([\d,]+(?:\.\d{2})?)/) : null;
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;
      const odoText = text(".vehicle-field-odometer .vehicle-info-value");
      return {
        vin,
        stock: card.querySelector("[data-sn]")?.getAttribute("data-sn") ?? null,
        title: text(".vehicle-title"),
        url: card.querySelector("a.vehicle-title")?.href ?? null,
        image: img?.currentSrc || img?.src || null,
        price: price != null && price >= 100 && price <= 500000 ? price : null,
        mileage: odoText ? Number(odoText.replace(/[^0-9]/g, "")) || null : null,
        drivetrain: text(".vehicle-field-drivetrain .vehicle-info-value"),
        transmission: text(".vehicle-field-transmission .vehicle-info-value"),
        fuel: text(".vehicle-field-fueltype .vehicle-info-value"),
        // Structural sold markers only — free-text matching would trip on
        // routine "sold as-is" disclaimer copy and wipe live vehicles.
        sold: !!card.querySelector('[class*="sold" i], img[alt*="sold" i]'),
      };
    });
  });
}

function findNextLink(page) {
  return page.evaluate(() => {
    const next = document.querySelector(
      'a[rel="next"], .pagination a.next, a.page-numbers.next, a[aria-label*="Next" i]'
    );
    return next?.href ?? null;
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  // The Chrome user-agent override is load-bearing: with the default
  // "HeadlessChrome" UA Cloudflare serves its challenge page and the scrape
  // times out (tested both ways). The client-hints mismatch it causes is
  // tolerated; do not remove.
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();

  const raw = [];
  let advertisedTotal = null; // the page's own "N Available" counter
  let url = INVENTORY_URL;
  for (let i = 0; i < MAX_PAGES && url; i++) {
    console.log(`Fetching page ${i + 1}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".vehicle-container[data-vehicle-id]", { timeout: 45_000 });

    // Cards lazy-load as the page scrolls. Scroll ONE viewport at a time —
    // jumping straight to the bottom skips the intersection triggers and
    // strands middle batches unloaded (tested). Stop only once the count has
    // been flat for 5 rounds (4s): slow CI runners + Cloudflare-throttled XHR
    // batches can take >2s to land.
    let count = 0;
    let stable = 0;
    for (let round = 0; round < 60 && stable < 5; round++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(800);
      const now = await page.locator(".vehicle-container[data-vehicle-id]").count();
      if (now > count) {
        count = now;
        stable = 0;
      } else {
        stable++;
      }
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const finalCount = await page.locator(".vehicle-container[data-vehicle-id]").count();
    console.log(`  ${finalCount} cards after scroll`);

    raw.push(...(await scrapePage(page)));
    if (advertisedTotal == null) {
      advertisedTotal = await page.evaluate(() => {
        const m = document.body.innerText.match(/(\d+)\s+Available/i);
        return m ? Number(m[1]) : null;
      });
    }
    const next = await findNextLink(page);
    url = next && next !== url ? next : null;
  }
  await browser.close();

  // Real vehicles only: full 17-char VIN, a title, not marked sold; dedupe by VIN.
  const seen = new Set();
  const vehicles = raw.filter((v) => {
    const keep = v.vin && v.vin.length === 17 && v.title && !v.sold && !seen.has(v.vin);
    if (!keep && v.title) {
      console.warn(`  skipping card: vin=${v.vin || "none"} title=${v.title}` +
        (v.sold ? " (sold marker)" : seen.has(v.vin) ? " (duplicate)" : ""));
    }
    if (keep) seen.add(v.vin);
    return keep;
  });

  // Upgrade card thumbnails (320x240) to TV resolution — but only on the known
  // image CDN; leave any other host's URL untouched.
  for (const v of vehicles) {
    if (v.image && !v.image.startsWith("http")) v.image = null;
    if (v.image) {
      try {
        if (new URL(v.image).host === IMAGE_CDN_HOST) {
          v.image = v.image.replace(/\/\d+\/\d+\//, "/1280/960/");
        }
      } catch {
        v.image = null;
      }
    }
    delete v.sold;
  }
  vehicles.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  if (vehicles.length === 0) {
    console.error("ABORT: scrape returned 0 vehicles — keeping existing inventory.json.");
    process.exit(1);
  }

  // The strongest partial-load check: the page advertises its own total
  // ("19 Available"). If we captured fewer than that, some lazy-load batch
  // never arrived — abort rather than under-display the lot.
  if (advertisedTotal && vehicles.length < advertisedTotal) {
    console.error(
      `ABORT: page advertises ${advertisedTotal} available but only ${vehicles.length} scraped — ` +
        "partial page load. Keeping existing inventory.json."
    );
    process.exit(1);
  }

  let previousCount = null;
  try {
    previousCount = JSON.parse(readFileSync(OUT_FILE, "utf8")).vehicles.length;
  } catch {
    /* first run — no previous file */
  }

  // Shrink guard: a partial page load must never overwrite a full inventory.
  if (
    previousCount &&
    vehicles.length < Math.ceil(previousCount * 0.6) &&
    !process.env.FORCE
  ) {
    console.error(
      `ABORT: scraped ${vehicles.length} vehicles but previous run had ${previousCount} — ` +
        "looks like a partial page load. Keeping existing inventory.json. " +
        "(Set FORCE=1 to accept a genuine large inventory drop.)"
    );
    process.exit(1);
  }

  // Selector-drift guard: if prices vanished across the board, the site's
  // markup changed — fail loudly instead of showing a price-less TV for weeks.
  const priced = vehicles.filter((v) => typeof v.price === "number").length;
  if (priced < vehicles.length * 0.7) {
    console.error(
      `ABORT: only ${priced}/${vehicles.length} vehicles have a price — selector drift? ` +
        "Keeping existing inventory.json."
    );
    process.exit(1);
  }

  writeFileSync(
    OUT_FILE,
    JSON.stringify({ updated_at: new Date().toISOString(), source: INVENTORY_URL, vehicles }, null, 2)
  );
  console.log(
    `Wrote ${vehicles.length} vehicles to inventory.json` +
      (previousCount != null ? ` (was ${previousCount})` : "")
  );
}

main().catch((err) => {
  console.error("Scrape failed:", err.message);
  process.exit(1);
});
