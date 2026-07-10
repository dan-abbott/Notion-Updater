# Patch Log

Reverse-chronological log of meaningful changes to Notion Updater.

---

### [0.5.1] — 2026-07-10
**Type:** Fix
**Scope:** `app/api/notion-sync/route.ts`, `package.json`
**Summary:** Notion reported "webhook request timed out" on every button click, even though the pipeline itself completed successfully (confirmed by the `[Status]` block continuing to update after the error appeared). Root cause: Notion's button-webhook has its own response-wait timeout, shorter than this pipeline's total runtime. Fixed by responding to Notion immediately and running the actual pipeline in the background.
**Details:**
- Added `@vercel/functions` dependency for `waitUntil()` — the version-independent Vercel primitive for "keep this promise running after the response is sent," as opposed to Next.js's own `after()`/`unstable_after()`, which requires Next.js 15.1+ (this project is intentionally pinned to 14.2.35 per the CVE fix in v0.1.0).
- `POST` now does the bare minimum synchronously: validate `NOTION_PAGE_ID`, post the first `updateStatus(pageId, 'Pulling in the data...')` (fast, so it's visibly there almost immediately), call `waitUntil(runSyncPipeline(pageId))`, and return `{ success: true, message: 'Sync started' }` right away — well within Notion's webhook response window.
- Extracted the entire former `POST` body (generateMetrics trigger, chart fetch, matching, Blob upload, Notion updates, all status updates) into a new `runSyncPipeline()` function, run via `waitUntil()`. This function has no HTTP response to return through by the time it's running — every failure path must update the `[Status]` block itself, since that's the only way a failure becomes visible once Notion has already gotten its immediate "Sync started" acknowledgment.
- `maxDuration = 60` (added in v0.5.0) is what actually allows the background work to keep running after the response is sent — `waitUntil()` extends the function's lifetime up to `maxDuration`, it doesn't grant unlimited extra time.
**Breaking:** Yes — the immediate HTTP response no longer reflects whether the sync actually succeeded (it only confirms the pipeline started). Anything that was checking the POST response body for `success`/`synced`/`failed` needs to check the `[Status]` block on the Notion page instead; the response now only ever says `{ success: true, message: 'Sync started' }` (assuming `NOTION_PAGE_ID` is set) or a `500` if that env var is missing.

---


**Type:** Feature
**Scope:** `app/api/notion-sync/route.ts` (requires paired changes in the Portfolio Tracker Apps Script project — see that repo's PATCH_LOG.md v0.3.2)
**Summary:** The Notion button now triggers the full pipeline in one click: pull today's data from the slide deck, run the analysis, then sync charts — with live-ish progress feedback written into a `[Status]` block on the Notion page.
**Details:**
- Added `export const maxDuration = 60` (Vercel Hobby's configurable ceiling) — the combined pipeline (headless import+analysis trigger, chart fetch, Blob uploads, Notion updates) can run well past the platform's 10s default timeout.
- Added `triggerGenerateMetrics()`: calls the Apps Script's Web App with `?action=generateMetrics`, which runs `UpdatePortfolio()` + `processPortfolioData()` headlessly (see the paired Apps Script change) and returns `{ success, phase?, error? }`. Throws with the specific failing phase if either step fails.
- Added `findStatusBlock()` / `updateStatus()`: same recursive-search pattern as chart anchors, but looks for a block starting with `[Status]` and overwrites its text with `[Status] <message>`. Preserves the block's actual type (`heading_3` vs `paragraph`) when updating, since Notion's API requires the update payload's key to match the block's own type. `updateStatus()` never throws — a status-write failure must never abort the actual sync.
- `POST` handler now sequences: `updateStatus("Pulling in the data...")` → `triggerGenerateMetrics()` → `updateStatus("Updating charts...")` → existing anchor-discovery/chart-fetch/Blob-upload/Notion-update flow → final `updateStatus()` reflecting full success, partial chart failure, or (via the outer catch) an outright failure with the specific error message.
- Requires a `[Status]` block to already exist somewhere on the Notion page (as a heading_3 or paragraph) — `updateStatus()` logs and no-ops if it can't find one, rather than creating one automatically.
- Refreshed `apps-script/Code.gs` (the reference copy kept in this repo for convenience) to match the actual current script, which was renamed to `Notion.gs` and gained the `?action=` routing in the Portfolio Tracker repo — the copy here had drifted out of date.
**Breaking:** No — additive. Existing behavior (chart sync) is unchanged if `generateMetrics` succeeds; the response JSON shape is unchanged.

---


**Type:** Fix
**Scope:** End-to-end verification
**Summary:** Confirmed the full sync pipeline works in production: Notion button trigger → Vercel middleware discovers `[Chart]` anchors → Apps Script returns chart data as JSON → middleware uploads to Vercel Blob via OIDC → Notion image blocks updated. No further changes required to close out this debugging arc.
**Details:**
- Verified with 2 real charts (`Monthly Burn Rate`, `User Growth`): both synced successfully after the `@vercel/blob` OIDC fix in v0.4.2.
- A `(node:4) [DEP0169] DeprecationWarning: url.parse()` message appears in logs but originates from Next.js/dependency internals, not this codebase (`route.ts` never calls `url.parse()`). Confirmed as informational only — no CVEs apply, no action needed. Noting here so it isn't mistaken for a regression in a future session.
- Remaining known gaps are documented as `[UNVERIFIED]`/edge cases in `KNOWN_INVARIANTS.md` (e.g. chart-title-mismatch handling) rather than active bugs.
**Breaking:** No.

---


**Type:** Fix
**Scope:** `package.json`, `.env.example`
**Summary:** Production run got "Vercel Blob: No token found" even with a Blob store connected, because Vercel's newer stores default to OIDC authentication (no static token at all) and the pinned SDK version predates OIDC support.
**Details:**
- Bumped `@vercel/blob` from `^0.27.0` to `^2.6.1` so the SDK recognizes the auto-injected `VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID` pair instead of only looking for a static `BLOB_READ_WRITE_TOKEN`.
- `.env.example` updated: removed the implication that `BLOB_READ_WRITE_TOKEN` is required in production; noted it's only relevant for local dev or legacy static-token stores.
- No changes needed to `route.ts` itself — `put()` calls are unchanged; this was purely a dependency version issue.
**Breaking:** No — purely additive/corrective; existing static-token stores continue to work unchanged.

---


**Type:** Fix
**Scope:** `app/api/notion-sync/route.ts`
**Summary:** Production run hit an unhandled `SyntaxError: Unexpected token '<'` when the Apps Script returned an HTML Google sign-in page instead of JSON. Reading the response as text first and JSON-parsing manually gives a diagnosable error instead of a raw crash.
**Details:**
- `fetchChartsFromScript()` now calls `.text()` first, then `JSON.parse()`s it in a try/catch, rather than calling `.json()` directly.
- On parse failure, the thrown error names the likely cause (Web App "Who has access" deployment setting) and includes the first 200 characters of the actual response body for diagnosis.
- Root cause of the specific failure this fixes the *symptom* for: the Apps Script Web App deployment's access was not set to "Anyone," so unauthenticated server-to-server calls were redirected to a Google login page. See `KNOWN_INVARIANTS.md` for the deployment setting itself — this patch only makes that failure mode legible, it doesn't fix the deployment setting (that's done in the Apps Script console, not code).
**Breaking:** No.

---


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
