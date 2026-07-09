# Patch Log

Reverse-chronological log of meaningful changes to Notion Updater.

---

### [0.4.0] — 2026-07-09
**Type:** Refactor
**Scope:** `app/api/notion-sync/route.ts`, `apps-script/Code.gs` (new)
**Summary:** User supplied the actual Apps Script source, revealing it already did full ImgBB upload + Notion block search/update itself — duplicating and conflicting with the middleware. Removed ImgBB entirely; Vercel Blob is now the single image host, and the Apps Script's only job is exporting chart data.
**Details:**
- `apps-script/Code.gs` (new, for reference/copy-paste into the Apps Script editor — not part of the Next.js build): `doGet` now just calls `exportAllChartsAsJson()`, which loops `sheet.getCharts()`, exports each as PNG, base64-encodes it, and returns `{ "charts": [{ "title", "imageBase64" }, ...] }` as JSON. All ImgBB upload code and all Notion API calls (token, page ID, recursive anchor search, block update/append) were removed from the script — that's the middleware's job now, not duplicated in two places.
- `route.ts`: replaced the old per-chart `?chart=` query-param fetch with `fetchChartsFromScript()`, a single GET that parses the script's `{ charts: [...] }` JSON.
- `syncOneChart()` no longer fetches anything — it takes the already-fetched `chart.imageBase64`, decodes it with `Buffer.from(..., 'base64')`, and uploads directly to Vercel Blob (with explicit `contentType: 'image/png'`, since a raw buffer doesn't carry a MIME type the way a fetched `Blob` did).
- Anchors (from Notion) and charts (from the script) are now matched by exact title string. Anchors with no matching chart, and charts with no matching anchor, are logged as warnings and included in the response (`unmatchedAnchors`, `unmatchedCharts`) rather than treated as fatal — only chart titles present on both sides get synced.
- If literally nothing matches on either side, the route still throws (nothing to do).
**Breaking:** Yes — the Apps Script's deployed Web App must be redeployed with the new `Code.gs` logic before this middleware version will work; the two are no longer interchangeable with the old script (which returned a plain-text success message, not JSON). Response shape also gained `unmatchedAnchors`/`unmatchedCharts` fields.

---


**Type:** Refactor
**Scope:** `app/api/notion-sync/route.ts`
**Summary:** Discovered in production that the Notion button sends no request body at all — it's a bare trigger. Replaced the single-`chartTitle`-from-request-body model with full-page discovery of every `[Chart] ...` anchor, synced independently in one run.
**Details:**
- Removed all request-body parsing (`chartTitle` was never actually sent by the Notion button; v0.2.0's assumption was wrong).
- `findAnchorAndTarget()` (single match) replaced with `findAllChartAnchors()`, which recursively collects **every** `heading_3`/`paragraph` block whose text starts with `"[Chart] "` anywhere in the page tree, extracting the chart title from each match (text after the prefix).
- Extracted per-chart sync logic into `syncOneChart()`: fetches the chart from the Google Apps Script with the chart title passed as a `?chart=` query param, uploads to Vercel Blob under a slugified filename (`charts/{slug}-{timestamp}.png`), then updates the existing image block or inserts a new one — same update-vs-insert branching as v0.2.0, now per-anchor.
- All discovered charts are synced via `Promise.allSettled`, so one chart's failure (bad script response, Notion API error, etc.) does not abort the others.
- Response shape changed: `{ success, synced: string[], failed: { chartTitle, error }[] }` instead of a single `success`/`message`/`error`. Returns HTTP 500 only if every chart failed; partial failures return 200 with the `failed` array populated so the caller can see per-chart status.
**Breaking:** Yes — response body shape changed (see above), and the Google Apps Script must now support a `?chart={title}` query parameter to return the correct chart image. If the script currently ignores query params and always returns one fixed image, every discovered chart will get the same image. Confirm the script reads `chart` from the query string before deploying this version.

---


**Type:** Feature
**Scope:** `app/api/notion-sync/route.ts`
**Summary:** Replaced the placeholder block-search logic with a working recursive anchor/target finder and added insert-if-missing handling.
**Details:**
- Added `findAnchorAndTarget()`: recursively walks Notion block children (fetching nested children live via `notion.blocks.children.list`) to find a `heading_3` or `paragraph` block whose text matches `[Chart] {chartTitle}`.
- `chartTitle` is now read from the incoming request body (`request.json()`), which is expected to come from the Notion button payload. Missing/invalid `chartTitle` now throws a clear error instead of silently using an undefined value.
- If the anchor's next sibling is already an `image` block, the sync updates it in place (`notion.blocks.update`).
- If no image block exists yet after the anchor, the sync now inserts one via `notion.blocks.children.append({ after: anchorId, ... })` instead of failing.
- If no anchor block is found at all, the route now throws a descriptive error naming the expected text, rather than proceeding with an undefined target.
**Breaking:** No — this is additive functionality on top of the existing flow (fetch chart → upload to Blob → update Notion). The request body contract changed: POST requests must now include `{ "chartTitle": "..." }` in the JSON body.

---

### [0.1.0] — 2026-07-09
**Type:** Migration
**Scope:** Project scaffolding (repo root, `app/`)
**Summary:** Added the Next.js project scaffolding that was missing from the repo, so the existing single-file API route can actually build and deploy.
**Details:**
- Added `package.json` with `next@14.2.35` (patched — 14.2.5 as originally used has known RSC vulnerabilities, see CVE-2025-55183/55184/67779), `@notionhq/client`, `@vercel/blob`, `react`, `react-dom`, plus TypeScript dev dependencies.
- Added `tsconfig.json` (standard Next.js App Router config).
- Added `next.config.mjs` (empty/default config).
- Added `app/layout.tsx` — minimal root layout required by the App Router even for API-only projects.
- Added `.env.example` documenting the four required environment variables: `NOTION_TOKEN`, `NOTION_PAGE_ID`, `GOOGLE_APPS_SCRIPT_URL`, `BLOB_READ_WRITE_TOKEN`.
- Added `.gitignore` (`node_modules`, `.next`, `.env*`, `next-env.d.ts`).
- Verified locally: `npm install` and `npm run build` both complete successfully.
**Breaking:** No — no existing behavior changed, only missing files added.
