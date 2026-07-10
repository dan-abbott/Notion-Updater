# Known Invariants

Non-negotiable rules and gotchas for anyone working on this codebase.

Stack: Next.js 14 (App Router) API route, deployed on Vercel, integrating Notion API (`@notionhq/client`), Vercel Blob (`@vercel/blob`), and a Google Apps Script web app as the chart/table data source.

---

### [Deployment] — Apps Script Web App must have "Who has access: Anyone"
**Rule:** The Web App deployment's access setting must be **Anyone** (with "Execute as: Me"), not "Only myself" or an org-restricted option. The middleware calls it as an unauthenticated external HTTP request.
**Why:** ⚠️ SILENT FAILURE in the sense that Google doesn't return a 401/403 — it returns a 200 OK containing an HTML sign-in page. Naively calling `.json()` on that response throws an opaque `Unexpected token '<'` parse error with no indication that the real problem is a permissions setting three steps removed from the actual code.
**Example (correct):** Deploy > Manage deployments > Edit > Who has access: **Anyone**.
**Example (wrong):** Who has access: **Only myself** — works fine when you test the URL in your own logged-in browser, fails silently (as an HTML page) when called from server-to-server code with no Google session.
**Source:** Observed in production — Apps Script call returned `<!DOCTYPE ...>` instead of the expected JSON.

---

### [Deployment] — The Apps Script Web App deployment and this repo's code must be kept in sync manually
**Rule:** `apps-script/Code.gs` in this repo is a reference copy — the actual executing code lives in the Google Apps Script project's Web App deployment, which must be redeployed (Deploy > Manage deployments > Edit > New version) any time the script changes. There is no CI/CD link between this repo and the Apps Script project; they are updated manually and independently.
**Why:** ⚠️ SILENT FAILURE — if the middleware is updated to expect a new response shape but the live Apps Script deployment still runs an older version, `fetchMappedDataFromScript()` will throw on JSON parsing (or on the missing arrays check), but there's no automated check to catch the mismatch before that happens in production.
**Example (correct):** After editing the script here, immediately open the Apps Script editor, paste the change, and create a new Web App deployment version.
**Example (wrong):** Editing the reference copy in this repo and assuming the live script picked it up automatically.
**Source:** Observed — this exact mismatch is what caused the `undefined` NOTION_PAGE_ID and validation errors earlier in this project's history.

---

### [API / External Integrations] — The Notion button trigger carries no payload
**Rule:** The button push arrives as a bare POST with no usable body. Do not add logic that expects `request.json()`/`request.body` to contain chart identifiers, user info, or anything else — there is nothing there to parse.
**Why:** ⚠️ SILENT FAILURE risk if a future change reintroduces body-parsing logic that "falls back" to a default instead of throwing — a fallback would quietly sync the wrong (or only some) data with no error.
**Example (correct):** Route ignores the request body entirely and asks the Apps Script for everything it needs via the Mapping sheet.
**Example (wrong):** `const chartTitle = body?.chartTitle ?? 'Default Chart'` — silently syncs the wrong thing forever.
**Source:** Observed production behavior early in this project's history; confirmed by user: the button is strictly a trigger.

---

### [API / External Integrations] — Charts and table rows are addressed by exact Notion block ID, not by page-text search
**Rule:** As of v0.6.0, there is NO anchor-text matching (`[Chart] Title`, `[Table] Label`) anywhere in this codebase. Every chart image block and every table row block is identified by its literal Notion block ID, sourced from the "Mapping" sheet in the Portfolio Tracker's Google Sheet (see that repo's invariants for the sheet's exact layout). `fetchMappedDataFromScript()` returns data that's already tagged with the block ID it belongs to — the middleware never walks the Notion page tree to *find* anything except the `[Status]` block.
**Why:** This was a deliberate user tradeoff: block IDs are copied into the Mapping sheet manually (once per chart/table row) rather than relying on visible anchor text on the page, which the user found unavoidably cluttered given Notion's limited text-styling controls. The cost is that block IDs aren't permanent — see the next invariant.
**Example (correct):** `syncOneMappedChart({ blockId, imageBase64 })` calls `notion.blocks.update({ block_id: blockId, image: {...} })` directly — no searching involved.
**Example (wrong):** Reintroducing `[Chart]`/`[Table]` prefix scanning "to make setup easier" — this was deliberately removed at the user's request; page content should stay free of anchor markers.
**Source:** User-specified design change; implemented in `route.ts` v0.6.0, paired with `Notion.gs` v0.4.0 (Portfolio Tracker repo).

---

### [API / External Integrations] — Block IDs in the Mapping sheet are NOT permanent; they must be re-copied if a block is recreated
**Rule:** If a table row or image block referenced in the Mapping sheet is ever deleted and recreated in Notion (including indirectly, e.g. rebuilding the whole table), its block ID changes. The Mapping sheet does not update itself — whoever maintains it must notice and re-copy the new ID.
**Why:** ⚠️ SILENT FAILURE — an update call to a block ID that no longer exists (or now belongs to something else) fails with a Notion API error for that one row/chart, surfaced via `Promise.allSettled` and the final status message's failure count, but nothing proactively flags *which* mapping row went stale or why.
**Example (correct):** After restructuring a table in Notion, re-copy each affected row's block ID (via the row's drag-handle "Copy link", or via the method the user found — Notion's built-in AI reporting row IDs) and update the Mapping sheet.
**Example (wrong):** Assuming the Mapping sheet stays valid indefinitely without any maintenance after Notion-side structural changes.
**Source:** User-acknowledged tradeoff, accepted as reasonable since studio count is expected to change rarely.

---

### [Environment / Config] — Three environment variables are required, with no fallback
**Rule:** `NOTION_TOKEN`, `NOTION_PAGE_ID`, and `GOOGLE_APPS_SCRIPT_URL` must all be set or the route throws at runtime, not at build time.
**Why:** ⚠️ SILENT FAILURE at build time — TypeScript's `!` non-null assertions (where used) or explicit runtime checks don't run until the route is actually invoked, so a missing var won't surface until the first real Notion button press.
**Example (correct):** All three vars set in Vercel Project Settings → Environment Variables before deploying.
**Example (wrong):** Deploying without `NOTION_PAGE_ID` set — build succeeds, first real request fails with a Notion API validation error citing `block_id` as `"undefined"`.
**Source:** Observed behavior in this project's history — this exact failure occurred before `NOTION_PAGE_ID` was set in Vercel.

---

### [Environment / Config] — Vercel Blob auth is OIDC-based, not a static token
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

---

### [Deployment] — `maxDuration` must stay explicit and sized for the current plan
**Rule:** `route.ts` exports `maxDuration = 60` (Vercel Hobby's configurable ceiling as of this writing). This must never be removed, and must be raised if the project moves to Pro and the pipeline grows (more charts, more table rows). This is also the hard ceiling on how long `waitUntil(runSyncPipeline(...))` is allowed to keep running after `POST` has already responded — it is not a separate, unlimited background-task budget.
**Why:** ⚠️ SILENT FAILURE at the platform level — Vercel's default function timeout (10s) is well under what the full `generateMetrics` + sync pipeline needs. Since the response is sent almost immediately (see the next invariant), a timeout here would no longer be visible to Notion at all — instead the background pipeline would simply get killed mid-run once `maxDuration` elapses, silently leaving the `[Status]` block on whatever message it last reached.
**Example (correct):** `export const maxDuration = 60;` at the top of `route.ts`, next to the other top-level exports.
**Example (wrong):** Removing this export to "clean up" the file, or leaving it at a stale low value after the pipeline grows.
**Source:** Vercel Functions documentation (https://vercel.com/docs/functions/configuring-functions/duration); added v0.5.0, criticality increased by the fire-and-forget restructure in v0.5.1.

---

### [API / External Integrations] — Notion's button-webhook has a shorter response timeout than this pipeline; POST must ack immediately
**Rule:** `POST` must never `await` the full sync pipeline before responding to Notion. It does the minimum synchronous work (validate `NOTION_PAGE_ID`, post the first status update, kick off `runSyncPipeline()` via `waitUntil()`) and returns immediately. All of the actual work happens in the background after the response is already sent.
**Why:** ⚠️ SILENT FAILURE from the user's perspective if this is violated — not a backend bug, but Notion's button UI reports "webhook request timed out" on every single run, training people to believe the sync is broken even when it completes successfully moments later. This was observed directly in production.
**Example (correct):** `POST` awaits only `updateStatus(pageId, 'Pulling in the data...')`, then `waitUntil(runSyncPipeline(pageId))`, then returns.
**Example (wrong):** Awaiting `runSyncPipeline()` (or equivalent inline logic) directly inside `POST` before returning a response — reintroduces the exact timeout Notion reported.
**Source:** User-reported production error ("Button failed to execute: webhook request timed out"); fixed in `route.ts` v0.5.1.

---

### [API / External Integrations] — `runSyncPipeline()` has no HTTP response to fail through; every path must update `[Status]` itself
**Rule:** Since `runSyncPipeline()` runs after `POST` has already returned a response, there is no way to report success or failure back through the HTTP layer anymore. Every branch — the `generateMetrics` failure, partial chart/row failures, full success, and the outer catch-all — must call `updateStatus()` with an outcome-specific message.
**Why:** ⚠️ SILENT FAILURE if a new failure branch is added without a corresponding `updateStatus()` call — since there's no response body left to inspect, a silently-swallowed error in the background pipeline would be genuinely invisible; the `[Status]` block is now the ONLY channel for reporting outcomes.
**Example (correct):** Every `return` inside `runSyncPipeline()`'s try block is preceded by an `updateStatus()` call describing what happened.
**Example (wrong):** Adding a new early-return path without also calling `updateStatus()` — the run would just silently stop with no visible indication anywhere.
**Source:** `route.ts` v0.5.1, direct consequence of the fire-and-forget restructure.

---

### [API / External Integrations] — `updateStatus()` must never throw, and never blocks the real sync
**Rule:** `updateStatus()` wraps its entire body in try/catch and logs (never rethrows) on failure. Nothing in the sync pipeline should ever be made to depend on a status update succeeding.
**Why:** ⚠️ SILENT FAILURE risk in the *other* direction if this rule is violated — the status block is a nice-to-have UX feature, not the point of the sync. If `updateStatus()` were allowed to throw, a missing `[Status]` block or a transient Notion API hiccup would abort an otherwise-successful sync for no good reason.
**Example (correct):** `updateStatus()`'s only failure mode is a `console.error` and a silent no-op.
**Example (wrong):** Letting a `findStatusBlock()` failure propagate up and abort the whole pipeline.
**Source:** `route.ts` v0.5.0.

---

### [API / External Integrations] — The `[Status]` block must already exist on the page; it is never auto-created
**Rule:** `updateStatus()` searches for a block whose text already starts with `[Status]` and updates it in place. It does not create one if none is found — it just logs and skips that update. This is the ONLY block on the page still found by text search (see the block-ID mapping invariant above for why everything else isn't).
**Why:** Auto-creating a status block would require deciding where on the page to put it and in what format, which is a layout decision that belongs to whoever set up the Notion page, not something the middleware should guess at silently.
**Example (correct):** Manually add a `[Status]` paragraph or heading_3 block to the page once, anywhere; every future `updateStatus()` call finds and rewrites it.
**Example (wrong):** Expecting status text to appear on a page that has never had a `[Status]` block added — check the Vercel logs for "No `[Status]` block found on the page" if updates don't seem to be showing up.
**Source:** `route.ts` v0.5.0; user explicitly requested a dedicated status block over reusing another anchor.

---

### [API / External Integrations] — Table row column count is validated by Notion itself, not pre-checked by this code
**Rule:** `syncOneMappedTableRow()` sends the Mapping sheet's resolved values straight to `notion.blocks.update()` without first checking them against the target row's existing column count. If they don't match, Notion's API rejects the update and the error propagates for that row only (via `Promise.allSettled`), same as any other per-row failure.
**Why:** Since v0.6.0 there's no "find the table, check its width" step anymore — the block ID already points at a specific existing row, and Notion enforces its own shape constraints. Re-adding a pre-check would mean an extra `blocks.retrieve()` call per row for something the platform already validates for free.
**Example (correct):** Let Notion's API return the validation error; log and count it as a per-row failure.
**Example (wrong):** Adding back a `blocks.retrieve()` + manual length check before every row update — redundant API calls for no additional safety.
**Source:** `route.ts` v0.6.0, simplification following the switch to direct block-ID addressing.
