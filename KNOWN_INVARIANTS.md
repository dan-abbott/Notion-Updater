# Known Invariants

Non-negotiable rules and gotchas for anyone working on this codebase.

Stack: Next.js 14 (App Router) API route, deployed on Vercel, integrating Notion API (`@notionhq/client`), Vercel Blob (`@vercel/blob`), and a Google Apps Script web app as the chart image source.

---

### [API / External Integrations] — Anchor block text must match exactly
**Rule:** The Notion page must contain a `heading_3` or `paragraph` block whose text is *exactly* `[Chart] {chartTitle}` (case-sensitive, no extra whitespace), where `chartTitle` is the value sent in the sync request body.
**Why:** ⚠️ SILENT FAILURE risk if the match logic is ever loosened to a substring/fuzzy match — but as currently written, a mismatch throws an explicit error rather than failing silently. Do not "helpfully" change the comparison to `.includes()` or case-insensitive matching without also handling the case where multiple blocks could now match.
**Example (correct):** Notion block text: `[Chart] Monthly Burn Rate`, request body: `{ "chartTitle": "Monthly Burn Rate" }`
**Example (wrong):** Notion block text: `Chart: Monthly Burn Rate` (missing the `[Chart] ` prefix) — sync will fail with "no anchor found."
**Source:** `findAnchorAndTarget()` in `app/api/notion-sync/route.ts`.

---

### [API / External Integrations] — Recursive child-fetching costs one Notion API call per nested block
**Rule:** Any block with `has_children: true` triggers a live `notion.blocks.children.list` call during the anchor search. Keep the anchor block as shallow as possible (ideally top-level on the page).
**Why:** Deeply nested anchors (e.g. inside multiple nested toggles/columns) will slow down every sync and increase the chance of hitting Notion API rate limits, especially since this all happens serially inside one request before the timeout budget on Vercel's serverless functions runs out.
**Example (correct):** Anchor block placed directly on the page body, no nesting.
**Example (wrong):** Anchor block buried inside a toggle inside a column inside another toggle.
**Source:** Recursive implementation in `route.ts`, added in v0.2.0.

---

### [API / External Integrations] — Image block insertion vs. update are two different code paths
**Rule:** If an image block already exists immediately after the anchor, the sync **updates** it (`notion.blocks.update`). If not, it **appends** a new one (`notion.blocks.children.append`). These are not interchangeable — `blocks.update` cannot create a block, and `blocks.children.append` cannot target a specific existing block.
**Why:** ⚠️ SILENT FAILURE if this distinction is collapsed — calling `update` on a non-existent block ID throws visibly (good), but calling `append` every time instead of `update` would silently pile up duplicate image blocks after the anchor on every sync, with no error at all.
**Example (correct):** Check `match.targetId` and branch accordingly (current implementation).
**Example (wrong):** Always calling `blocks.children.append` regardless of whether an image already exists.
**Source:** `route.ts`, v0.2.0.

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

---

### [UNVERIFIED] — Google Apps Script response is assumed to always be image/png
**Rule (tentative):** The code treats `scriptResponse.blob()` as image data and writes it to `charts/dashboard-plot-{timestamp}.png` regardless of the actual `Content-Type` header returned by the Apps Script.
**Why:** If the Apps Script ever returns an error page (e.g. HTML from a Google auth redirect) instead of the chart image, this would upload non-image content to Blob storage and pass a broken URL to Notion — Notion would likely just fail to render the image block, which is not fully silent but also not clearly diagnosed by the current error handling.
**What would confirm/deny it:** Check whether the Apps Script always returns `Content-Type: image/png` even on its own internal errors, and consider adding a content-type check before the Blob upload.
**Source:** Inferred from code; not confirmed against the actual Apps Script implementation (not provided).
