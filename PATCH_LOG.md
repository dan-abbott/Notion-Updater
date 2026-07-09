# Patch Log

Reverse-chronological log of meaningful changes to Notion Updater.

---

### [0.2.0] — 2026-07-09
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
