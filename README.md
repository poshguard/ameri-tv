# Ameri Auto Group — TV Inventory Display

A simple TV screen for the showroom. It shows every car currently listed on
**ameriautogroup.com** — big photo, price, and mileage — one car at a time,
on a loop, with a QR code customers can scan to open the website on their phone.

**When a car is removed from the website, it disappears from the TV
automatically.** Nothing to manage.

## How to put it on your TV

1. Open the TV's web browser (Smart TV, Fire TV Stick, or Chromecast with Google TV).
2. Go to the display link (you'll get it after hosting — see below).
3. That's it. The page runs forever: it changes cars every 10 seconds,
   re-checks the website every 10 minutes, and keeps itself awake.

Tip: on a Fire TV Stick, install the free "Silk Browser" app, open the link
once, and bookmark it.

## How it works

- `index.html` — the TV page (everything in one file).
- `inventory.json` — the current list of cars, pulled from the website.
- `scrape.mjs` — the robot that reads ameriautogroup.com's inventory page.
- `.github/workflows/update-inventory.yml` — runs the robot automatically
  every 6 hours on GitHub's servers (free) and saves the fresh list.

If a scrape ever fails (website down, layout changed), the TV simply keeps
showing the last good list — it never goes blank. A failed update also opens
a GitHub issue on this repo automatically so you notice.

Notes:
- The repo must stay **public** — that's what makes GitHub Pages and Actions free.
- If scheduled runs ever get blocked by the website's bot protection
  (Cloudflare), run the update from any computer instead:
  `node scrape.mjs`, then commit and push `inventory.json`.

## Update the list right now

On GitHub: **Actions → "Update inventory from ameriautogroup.com" → Run workflow.**
Two minutes later the TV picks it up on its next 10-minute refresh (or reload the page).

## Run locally (for testing)

```bash
npm install
npx playwright install chromium
node scrape.mjs          # refreshes inventory.json from the website
python3 -m http.server 8090   # then open http://localhost:8090
```
