# Known Invariants

Non-negotiable rules and gotchas for anyone working on this codebase.

Stack: Next.js 14 (App Router) API route, deployed on Vercel, integrating Notion API (`@notionhq/client`), Vercel Blob (`@vercel/blob`), and a Google Apps Script web app as the chart image source.

---

### [API / External Integrations] — The Notion button trigger carries no payload
**Rule:** The button push arrives as a bare POST with no usable body. Do not add logic that expects `request.json()`/`request.body` to contain chart identifiers, user info, or anything else — there is nothing there to parse.
**Why:** ⚠️ SILENT FAILURE risk if a future change reintroduces body-parsing logic that "falls back" to a default instead of throwing — a fallback would quietly sync the wrong (or only one) chart with no error, which is exactly the class of bug v0.2.0 shipped with (it assumed a `chartTitle` field that was never sent).
**Example (correct):** Route ignores the request body entirely and instead discovers all chart anchors by reading the Notion page directly.
**Example (wrong):** `const chartTitle = body?.chartTitle ?? 'Default Chart'` — silently syncs the wrong thing forever.
**Source:** Observed production behavior (v0.2.0 failed immediately in prod with "Request body must include a chartTitle field"), confirmed by user: the button is strictly a trigger.

---

### [API / External Integrations] — Chart anchors are discovered by prefix match, not exact match, and there can be many per page
**Rule:** Any `heading_3` or `paragraph` block whose text starts with `[Chart] ` is treated as a chart anchor; everything after that prefix (trimmed) becomes the chart's title, which is then sent to the Apps Script as the `chart` query param. The page is expected to contain zero or more such anchors, and all of them are synced in a single run.
**Why:** Since there is no per-request targeting information, the anchor prefix in the Notion page itself is the only source of truth for which charts exist and what to call them. Renaming an anchor's title effectively renames which chart image the Apps Script is asked to render next sync — do this deliberately.
**Example (correct):** Block text `[Chart] Monthly Burn Rate` → chart title sent to script is `Monthly Burn Rate`.
**Example (wrong):** Assuming there's only ever one `[Chart]` block on the page — the current code will find and sync all of them, so an old/stale `[Chart]` block left on the page will keep getting synced too.
**Source:** `findAllChartAnchors()` / `syncOneChart()` in `route.ts`, v0.3.0.

---

### [API / External Integrations] — [UNVERIFIED] The Apps Script must honor a `chart` query parameter
**Rule (tentative):** `syncOneChart()` calls the Apps Script as `GET {GOOGLE_APPS_SCRIPT_URL}?chart={chartTitle}`, assuming the script branches on this parameter to return the correct chart's image.
**Why:** ⚠️ SILENT FAILURE if the script ignores the query param — every discovered chart anchor would get uploaded the exact same image, with no error at any layer (the fetch succeeds, the upload succeeds, the Notion update succeeds; only the visible content is wrong).
**What would confirm/deny it:** Check the Apps Script's `doGet(e)` handler for `e.parameter.chart` (or equivalent) and confirm it actually changes which chart is rendered.
**Example (correct):** Script reads `e.parameter.chart`, looks up the matching chart definition, and renders only that one.
**Example (wrong):** Script always renders whatever chart is currently active in the spreadsheet, ignoring the query string entirely.
**Source:** Inferred from the multi-chart redesign; not confirmed against the actual Apps Script (not provided in this repo).

---



### [API / External Integrations] — Recursive child-fetching costs one Notion API call per nested block
**Rule:** Any block with `has_children: true` triggers a live `notion.blocks.children.list` call during the anchor search. Keep the anchor block as shallow as possible (ideally top-level on the page).
**Why:** Deeply nested anchors (e.g. inside multiple nested toggles/columns) will slow down every sync and increase the chance of hitting Notion API rate limits, especially since this all happens serially inside one request before the timeout budget on Vercel's serverless functions runs out.
**Example (correct):** Anchor block placed directly on the page body, no nesting.
**Example (wrong):** Anchor block buried inside a toggle inside a column inside another toggle.
**Source:** Recursive implementation in `route.ts`, added in v0.2.0.

---

### [API / External Integrations] — Image block insertion vs. update are two different code paths, per anchor
**Rule:** For each discovered chart anchor, if an image block already exists immediately after it, the sync **updates** it (`notion.blocks.update`). If not, it **appends** a new one (`notion.blocks.children.append`). This check happens independently per anchor inside `syncOneChart()` — there is no page-level "first sync vs. later sync" flag.
**Why:** ⚠️ SILENT FAILURE if this distinction is collapsed — calling `update` on a non-existent block ID throws visibly (good), but calling `append` every time instead of `update` would silently pile up duplicate image blocks after each anchor on every sync, with no error at all.
**Example (correct):** Check `targetId` per anchor and branch accordingly (current implementation).
**Example (wrong):** Always calling `blocks.children.append` regardless of whether an image already exists for that anchor.
**Source:** `route.ts`, originally v0.2.0, generalized to multiple anchors in v0.3.0.

---

### [Environment / Config] — Four environment variables are required, with no fallback
**Rule:** `NOTION_TOKEN`, `NOTION_PAGE_ID`, `GOOGLE_APPS_SCRIPT_URL` must all be set (as non-null via `!` assertions in the code) or the route will throw at runtime, not at build time.
**Why:** ⚠️ SILENT FAILURE at build time — the `!` non-null assertions mean TypeScript won't catch a missing env var; the build will succeed and the route will only fail when invoked. Vercel Blob's token (`BLOB_READ_WRITE_TOKEN`) is normally auto-injected by Vercel when Blob storage is attached to the project, but must be set manually for local dev.
**Example (correct):** All four vars set in Vercel Project Settings → Environment Variables before deploying.
**Example (wrong):** Deploying without `NOTION_PAGE_ID` set — build succeeds, first real request 500s with "Cannot read properties of undefined."
**Source:** Observed behavior; `process.env.X!` pattern in `route.ts`.

---

### [File / Module Conventions] — This is a single-route App Router project, not a full app
**Rule:** There is intentionally no `page.tsx`, no UI routes — just `app/layout.tsx` (required scaffolding) and `app/api/notion-sync/route.ts`. Don't add pages/routes unless the project's scope actually changes to include a UI.
**Why:** Keeps the deploy surface minimal and avoids introducing routes that aren't needed for a pure webhook-receiver middleware.
**Example (correct):** Adding a new API route under `app/api/<name>/route.ts` for a new webhook.
**Example (wrong):** Adding `app/page.tsx` "just in case" — increases build surface with no purpose.
**Source:** Project scope as described by the user (middleware triggered by a Notion button push).

---

### [Deployment] — Next.js version is pinned to a patched release
**Rule:** Do not downgrade `next` below `14.2.35` on the 14.x line (or the equivalent patched minimum on any 15.x/16.x line, if upgraded later).
**Why:** Versions prior to 14.2.35 are affected by CVE-2025-55183, CVE-2025-55184, and CVE-2025-67779 (React Server Components DoS / source-code exposure). Vercel blocks deployment of known-vulnerable versions, so an accidental downgrade will surface as a deploy failure — not silent, but worth knowing why.
**Example (correct):** `"next": "14.2.35"` or later in `package.json`.
**Example (wrong):** `"next": "14.2.5"` (the version originally installed, before this was caught).
**Source:** Next.js Security Update, Dec 11 2025 (https://nextjs.org/blog/security-update-2025-12-11).


