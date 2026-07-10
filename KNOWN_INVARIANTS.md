# Known Invariants

Non-negotiable rules and gotchas for anyone working on this codebase.

Stack: Next.js 14 (App Router) API route, deployed on Vercel, integrating Notion API (`@notionhq/client`), Vercel Blob (`@vercel/blob`), and a Google Apps Script web app as the chart image source.

---

### [Deployment] — Apps Script Web App must have "Who has access: Anyone"
**Rule:** The Web App deployment's access setting must be **Anyone** (with "Execute as: Me"), not "Only myself" or an org-restricted option. The middleware calls it as an unauthenticated external HTTP request.
**Why:** ⚠️ SILENT FAILURE in the sense that Google doesn't return a 401/403 — it returns a 200 OK containing an HTML sign-in page. Naively calling `.json()` on that response throws an opaque `Unexpected token '<'` parse error with no indication that the real problem is a permissions setting three steps removed from the actual code.
**Example (correct):** Deploy > Manage deployments > Edit > Who has access: **Anyone**.
**Example (wrong):** Who has access: **Only myself** — works fine when you test the URL in your own logged-in browser, fails silently (as an HTML page) when called from server-to-server code with no Google session.
**Source:** Observed in production — Apps Script call returned `<!DOCTYPE ...>` instead of the expected JSON.

---
**Rule:** `apps-script/Code.gs` in this repo is a reference copy — the actual executing code lives in the Google Apps Script project's Web App deployment, which must be redeployed (Deploy > Manage deployments > Edit > New version) any time `Code.gs` changes here. There is no CI/CD link between this repo and the Apps Script project; they are updated manually and independently.
**Why:** ⚠️ SILENT FAILURE — if the middleware is updated to expect JSON (`{ charts: [...] }`) but the live Apps Script deployment still runs the old ImgBB/Notion-calling version, the middleware's `fetchChartsFromScript()` will throw on JSON parsing, but there's no automated check to catch the mismatch before that happens in production.
**Example (correct):** After editing `Code.gs` here, immediately open the Apps Script editor, paste the change, and create a new Web App deployment version.
**Example (wrong):** Editing `Code.gs` in this repo and assuming the live script picked it up automatically.
**Source:** Observed — this exact mismatch is what caused the `undefined` NOTION_PAGE_ID and validation errors earlier in this project's history.

---
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

### [API / External Integrations] — Vercel Blob is the ONLY image host; the Apps Script must not also upload anywhere
**Rule:** The Apps Script's job is strictly: export each chart as PNG, base64-encode it, return it as JSON. It must never call ImgBB, Notion, or any other upload target — `route.ts` owns image hosting (Vercel Blob) and the Notion update exclusively.
**Why:** ⚠️ SILENT FAILURE if this boundary blurs again — this is exactly the bug that shipped originally: the script silently uploaded to ImgBB and updated Notion on its own, while the middleware *also* tried to do a competing update, and neither side knew about the other. Two systems independently "finding and fixing" the same Notion blocks is a race condition, not a redundancy.
**Example (correct):** Script returns `{ charts: [{ title, imageBase64 }] }` and does nothing else. Middleware decodes, uploads to Blob, updates Notion.
**Example (wrong):** Script uploads to ImgBB and calls the Notion API directly (the original script's behavior, replaced in v0.4.0).
**Source:** User-provided original `Code.gs`, which revealed the duplication; corrected in v0.4.0.

---

### [API / External Integrations] — Chart-to-anchor matching is by exact title string, from two independent sources
**Rule:** A chart from the script (its `title`, taken from the Google Sheets chart's own title setting) is only synced to a Notion anchor if `anchor.chartTitle === chart.title` exactly (case-sensitive, exact whitespace). These titles live in two different systems (Google Sheets chart config, Notion page text) with no shared ID — keeping them in sync is a manual convention, not enforced anywhere.
**Why:** A typo or rename on either side (renaming a chart in Sheets, or editing the Notion anchor text) silently breaks the match for that one chart — it shows up in `unmatchedAnchors` or `unmatchedCharts` in the response, not as a hard failure, so it's easy to miss unless someone checks the response body or logs.
**Example (correct):** Sheets chart titled `Monthly Burn Rate`, Notion block reading `[Chart] Monthly Burn Rate`.
**Example (wrong):** Sheets chart titled `Monthly Burn Rate `  (trailing space) — will not match `[Chart] Monthly Burn Rate` and will silently land in `unmatchedCharts` every run.
**Source:** `route.ts`, matching logic added in v0.4.0.

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

### [Environment / Config] — Three environment variables are required, with no fallback
**Rule:** `NOTION_TOKEN`, `NOTION_PAGE_ID`, and `GOOGLE_APPS_SCRIPT_URL` must all be set or the route throws at runtime, not at build time.
**Why:** ⚠️ SILENT FAILURE at build time — TypeScript's `!` non-null assertions (where used) or explicit runtime checks don't run until the route is actually invoked, so a missing var won't surface until the first real Notion button press.
**Example (correct):** All three vars set in Vercel Project Settings → Environment Variables before deploying.
**Example (wrong):** Deploying without `NOTION_PAGE_ID` set — build succeeds, first real request fails with a Notion API validation error citing `block_id` as `"undefined"`.
**Source:** Observed behavior in this project's history — this exact failure occurred before `NOTION_PAGE_ID` was set in Vercel.

---


**Rule:** Do not add or rely on a manually-set `BLOB_READ_WRITE_TOKEN` for production. New Blob stores connected to a project default to OIDC: Vercel auto-injects `BLOB_STORE_ID` and a short-lived `VERCEL_OIDC_TOKEN` at runtime, and the `@vercel/blob` SDK reads both automatically — no code change and no token in env vars required. This requires `@vercel/blob` to be a recent version (OIDC-aware); `^0.27.0` predates this and will throw "No token found" even when the store is correctly connected.
**Why:** ⚠️ SILENT FAILURE risk in the other direction — if someone "fixes" a future auth error by manually pasting a static `BLOB_READ_WRITE_TOKEN` into Vercel env vars, it will work, but it reintroduces exactly the long-lived-secret risk Vercel moved away from, and creates a second, undocumented auth path alongside OIDC.
**Example (correct):** Connect a Blob store to the project via the Storage tab, keep `@vercel/blob` current, deploy — no manual token needed.
**Example (wrong):** Seeing "No token found" and adding a static `BLOB_READ_WRITE_TOKEN` as the fix, when the actual fix was bumping an outdated SDK version.
**Source:** Observed in production — SDK pinned to `^0.27.0` threw "No token found" despite `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY` being present (the OIDC-mode env vars); resolved by bumping to `^2.6.1`.

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


