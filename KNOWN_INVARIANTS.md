# Known Invariants

Non-negotiable rules and gotchas for anyone working on this codebase.

Stack: Next.js 14 (App Router), deployed on Vercel, integrating Notion API (`@notionhq/client`), Vercel Blob (`@vercel/blob`), and per-connector Google Apps Script web apps as the chart/table data source. Supports many independent connectors (each its own Notion page + Apps Script pair), registered in `connectors.json`. Includes a setup wizard (`/setup`) for onboarding new connectors, in addition to the core sync API route.

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

### [File / Module Conventions] — This app now has a real UI (`/setup`) alongside its API routes; keep them clearly separated
**Rule:** `app/setup/` is the only page-rendering route in this project — everything else is API routes under `app/api/`. Don't blur this: the setup wizard is a one-time/occasional tool for onboarding new connectors, not a dashboard for operating them; resist the urge to grow it into a general admin panel unless that's a deliberate, separate decision.
**Why:** This project was originally (and mostly still is) a pure webhook-receiver middleware with zero UI. Adding `/setup` was a deliberate, scoped exception to solve one specific pain point (manual block-ID hunting) — not a signal to start building arbitrary UI here.
**Example (correct):** `/setup` handles connector onboarding only; day-to-day sync behavior lives entirely in `/api/notion-sync/[connectorId]`.
**Example (wrong):** Adding a `/dashboard` page to show sync history "while we're at it" — a different scope decision that should be made deliberately, not organically.
**Source:** User-directed scope for the setup wizard; supersedes the prior "single-route project" invariant now that `/setup` exists.

---

### [API / External Integrations] — Every Notion page must be explicitly shared with the integration; this fails silently and generically otherwise
**Rule:** A page ID being correct is not sufficient for any Notion API call against it to succeed — the page must also have been shared with the integration in Notion's own UI (page → ••• → Connections). `explainNotionError()` (`lib/notion.ts`) detects this specific failure (`APIErrorCode.ObjectNotFound`) and returns a message naming the fix; it's used everywhere Notion API errors reach a person (the setup wizard's `list-blocks`, and the sync route's outer catch).
**Why:** ⚠️ SILENT FAILURE if this detection is removed or bypassed — Notion returns the exact same generic "object not found" error for a genuinely wrong page ID and for a correct-but-unshared page, so without this specific check, someone would have no way to tell which problem they actually have from the error message alone.
**Example (correct):** Any new code path that surfaces a Notion API error to a person routes it through `explainNotionError()` first.
**Example (wrong):** A new error-handling path that does `error instanceof Error ? error.message : String(error)` directly — loses this specific, actionable detection.
**Source:** User-flagged gap ("don't we need to link the connector to the Notion page?"); implemented in `route.ts`/`lib/notion.ts` v0.8.1.

---
**Rule:** As of v0.8.0, both `Row Block ID` and `Block ID` mapping rows carry their own tab name (column C). There is no more global "Data Source Tab" cell — a spreadsheet with multiple tabs of data can mix mappings from any of them in the same Mapping sheet.
**Why:** ⚠️ SILENT FAILURE risk if a mapping row's tab name is left blank or misspelled — `readMappingSheet()` treats a missing tab name the same as a missing source cell/chart title: the row is skipped with a warning, not a hard failure, so it's easy to miss unless the warnings array is actually checked.
**Example (correct):** Two mapping rows can reference `Testing` and `Studio Summary` tabs in the same Mapping sheet without conflict.
**Example (wrong):** Reintroducing a shared default tab "to simplify the common case" — reopens the exact limitation this was built to remove, and creates two different code paths (per-row tab vs. shared tab) to maintain.
**Source:** User-requested change; implemented in `lib/generateConnectorFiles.ts` v0.8.0, mirrored in `Notion.gs` v0.6.0 (Portfolio Tracker repo).

---

### [Database / ORM Query Patterns] — Existing Mapping sheets need manual migration to the per-row-tab layout
**Rule:** Any Mapping sheet built before v0.8.0 uses the old single-`B1`-tab layout and will not work with the regenerated `Notion.gs` until migrated: add a tab-name column (C) to every mapping row, shifting table rows' source cells one column right.
**Why:** This is a data-layout change, not a backward-compatible extension — `readMappingSheet()` no longer reads `B1` at all, so an unmigrated sheet's mappings will simply have blank tab names and get silently skipped (as warnings, not errors) rather than falling back to any old shared-tab behavior.
**Example (correct):** Before syncing with the new script, manually insert the tab name into column C of every existing mapping row.
**Example (wrong):** Deploying the new `Notion.gs` against an unmigrated Mapping sheet and assuming it still works — every row will report "missing a sheet tab" in the warnings array and sync nothing.
**Source:** Observed necessity during the v0.8.0 migration; the Portfolio Tracker's own live Mapping sheet required exactly this.

---
**Rule:** `getConnectorConfig(connectorId)` (`lib/connectors.ts`) is the only source of truth for which Notion page and Apps Script URL a given sync request targets. The `connectorId` comes from the dynamic route segment (`/api/notion-sync/[connectorId]`), never from a request body or a single global env var.
**Why:** ⚠️ SILENT FAILURE if a new connector's button is pointed at a URL with a typo'd or missing connector ID — `getConnectorConfig()` throws with a list of known connector IDs specifically so this fails loud and specific rather than silently reusing another connector's config or a stale env var.
**Example (correct):** Team B's Notion button posts to `/api/notion-sync/team-b`; `connectors.json` has a `"team-b"` entry.
**Example (wrong):** Reintroducing a single `NOTION_PAGE_ID`/`GOOGLE_APPS_SCRIPT_URL` env-var fallback "for backwards compatibility" — defeats the entire point of per-connector routing and risks silently syncing the wrong page.
**Source:** `lib/connectors.ts`, `route.ts` v0.7.0.

---

### [API / External Integrations] — `NOTION_TOKEN` is the one thing that stays a shared env var, not per-connector
**Rule:** Do not add a per-connector Notion token to `connectors.json`. Every connector uses the same `NOTION_TOKEN` — this was an explicit user decision, not an oversight.
**Why:** Simplifies the config schema and avoids needing per-connector secret management; revisit only if a future connector genuinely needs to write to a different Notion workspace under a different integration.
**Example (correct):** `lib/notion.ts` instantiates one `Client` from `process.env.NOTION_TOKEN`, imported by every route that needs it.
**Example (wrong):** Adding `notionToken` to each `connectors.json` entry "for flexibility" without a concrete need — expands the config surface and secret-handling burden for no current benefit.
**Source:** User-specified design decision during the multi-connector planning discussion.

---

### [API / External Integrations] — The setup wizard generates a literal function CALL, never dynamic reflection
**Rule:** `generateNotionGsCode()`'s templated `runPreExportStep()` body is always a plain, literal call to a named function (e.g. `return generateMetricsRemote();`) or a no-op success — never something like `this[functionName]()` resolved at runtime.
**Why:** Runtime reflection on function names is more fragile across Apps Script's execution model (V8 runtime `this`-binding behavior for top-level function declarations isn't something to rely on) and is harder for a human to read/debug afterward than a plain generated call. Since this code is generated once at setup time, there's no benefit to deferring the name resolution to runtime.
**Example (correct):** Wizard input "generateMetricsRemote" produces literal generated text `return generateMetricsRemote();`.
**Example (wrong):** Generating `return this[CONFIG.PRE_EXPORT_FUNCTION_NAME]();` and passing the name as a config constant — adds a runtime failure mode for no benefit.
**Source:** `lib/generateConnectorFiles.ts`, `route.ts` v0.7.1.

---

### [API / External Integrations] — The wizard NEVER generates page-specific automation logic
**Rule:** `/setup` only ever generates `Notion.gs` (the generic Web App entry point + Mapping sheet reader) and a literal call to a pre-export function the user names. It must never attempt to generate the actual logic of something like `Data Acquisition.gs`/`portfolio.gs` — those are assumed to already exist, hand-written, specific to that connector's own data source.
**Why:** This was an explicit scope boundary from the user: page-specific import/analysis logic varies too much per connector to templatize sensibly, and attempting to would turn a focused, reliable code generator into a much riskier one that guesses at business logic.
**Example (correct):** User types "generateMetricsRemote" as the pre-export function name; the wizard generates a call to it and nothing more.
**Example (wrong):** The wizard trying to infer what a "pre-export step" should do and writing that logic itself.
**Source:** Explicit user instruction during the wizard's design discussion.

---

### [Database / ORM Query Patterns] — Every `table` block always gets its rows fetched explicitly, regardless of `has_children`
**Rule:** `walkBlocks()` in `app/api/setup/list-blocks/route.ts` special-cases `block.type === 'table'`, always calling `describeTable()` (which unconditionally fetches its rows) rather than relying on the generic `has_children` recursion check used for everything else.
**Why:** ⚠️ SILENT FAILURE if this is narrowed to only the generic `has_children` path — the entire reason this endpoint fetches table rows explicitly is that Notion's own UI won't reliably give you an individual row's link (only the whole table's), and the wizard's page-mirroring layout (v0.9.0) requires every row's real cell content and block ID to render the grid at all.
**Example (correct):** Every `table` block triggers `describeTable()`, which always fetches its `table_row` children via `fetchAllChildren()`.
**Example (wrong):** Relying solely on `has_children` and assuming it always correctly reflects whether a table has rows worth fetching — even if true today, this is exactly the kind of platform assumption worth pinning down explicitly rather than leaving implicit.
**Source:** `app/api/setup/list-blocks/route.ts`, originally v0.7.1, restructured into `describeTable()` in v0.9.0.

---

### [Database / ORM Query Patterns] — `list-blocks` returns tables as ONE structured unit, never flattened into individual rows
**Rule:** `walkBlocks()` must never push a table's `table_row` children as separate flat items in the returned list. Every table becomes exactly one `{ kind: 'table', columns, rows }` entry, with its data rows nested inside.
**Why:** ⚠️ SILENT FAILURE risk if this reverts to flattening — the whole point of the v0.9.0 UI redesign is rendering an actual grid that mirrors the Notion table, with inputs aligned under real column headers. A flattened list can't be rendered that way; reverting the API shape would silently break the wizard's layout without necessarily causing an error (React would just render something structurally wrong, not throw).
**Example (correct):** One table with 3 data rows produces exactly one item in the response, with `rows: [...]` containing all 3.
**Example (wrong):** Pushing the table block itself AND its `table_row` children as separate flat list entries (the pre-v0.9.0 behavior) — works for a "list of blocks with IDs" UI, but is the wrong shape for a page-mirroring grid.
**Source:** User-requested redesign; implemented in `list-blocks`/`app/setup/page.tsx` v0.9.0.

---

### [UI / Component Constraints] — Block IDs are never displayed in the wizard UI, only carried internally in state
**Rule:** No component in `app/setup/page.tsx` renders a raw Notion block ID as visible text. Every block/row/image still has its ID available (as object keys in `chartDetails`/`tableRowDetails`, or embedded in the `items`/`rows` API response) — it's just not shown.
**Why:** User-requested simplification: block IDs are implementation detail, not something a person configuring a connector needs to see or think about. The current Notion value of a cell (shown as the input's placeholder) does the job block IDs used to do — identifying which row is which — without the visual clutter.
**Example (correct):** A table row's current Notion cell content (`row.cells[i]`) is shown as the placeholder text for that column's input.
**Example (wrong):** Re-adding a `<code>{block.id}</code>` anywhere in the rendered layout "just in case it's useful" — reopens the clutter this redesign was meant to remove.
**Source:** User-requested design change; implemented in `app/setup/page.tsx` v0.9.0.

---

### [UI / Component Constraints] — Editing a Step 1 input must immediately invalidate its previously generated output
**Rule:** Changing `preExportFunctionName` clears both `notionGsCode` and `appsScriptUrl` right away, rather than leaving the last-generated result on screen until someone explicitly clicks "Generate Notion.gs" again.
**Why:** ⚠️ SILENT FAILURE if this invalidation is skipped — a person could edit the field, not notice the displayed code/URL are unchanged, and copy/deploy output that silently doesn't match what they think they configured. This was reported in production as "Notion.gs includes a pre-export call even with the field empty," when the actual bug was stale output, not incorrect generation.
**Example (correct):** Typing in the pre-export field immediately blanks the code block and URL input, visibly signaling "not generated yet."
**Example (wrong):** Letting the old generated code remain visible/copyable after the input it depended on has changed.
**Source:** User-reported confusion; fixed in `app/setup/page.tsx` v0.8.3. (The generator itself, `generateNotionGsCode()`, was verified correct for empty/undefined/whitespace input before concluding this was a UI-state bug, not a codegen bug.)

---
**Rule:** Do not downgrade `next` below `14.2.35` on the 14.x line (or the equivalent patched minimum on any 15.x/16.x line, if upgraded later).
**Why:** Versions prior to 14.2.35 are affected by CVE-2025-55183, CVE-2025-55184, and CVE-2025-67779 (React Server Components DoS / source-code exposure). Vercel blocks deployment of known-vulnerable versions, so an accidental downgrade will surface as a deploy failure — not silent, but worth knowing why.
**Example (correct):** `"next": "14.2.35"` or later in `package.json`.
**Example (wrong):** `"next": "14.2.5"` (the version originally installed, before this was caught).
**Source:** Next.js Security Update, Dec 11 2025 (https://nextjs.org/blog/security-update-2025-12-11).

---

### [Database / ORM Query Patterns] — `column_list` blocks are returned as one nested-array-per-column unit, never flattened
**Rule:** `parseChildren()` special-cases `block.type === 'column_list'` the same way it special-cases `table`: fetch its `column` children, recursively parse each one's contents, and return `{ kind: 'columns', columns: PageBlockItem[][] }` — one array per column — rather than flattening everything into the parent's shared item list at increasing depth.
**Why:** ⚠️ SILENT FAILURE if this reverts to flattening — depth-based indentation alone cannot distinguish "these five images are one each in five side-by-side columns" from "these five images are nested five levels deep in a single column," which was the exact ambiguity reported in production once a real page grew from 1 to 2 to 4 columns (with nesting). Losing this distinction doesn't error, it just silently produces a wizard layout a person can no longer correctly interpret.
**Example (correct):** A `column_list` with 4 columns produces one `columns` item with a 4-element `columns` array, each rendered as its own side-by-side box.
**Example (wrong):** Treating `column_list`/`column` as just another generically-recursed container (the pre-v0.9.1 behavior) — everything inside ends up in one flat list, indented, with no visual indication of which column anything belongs to.
**Source:** User-reported ambiguity as their Notion page grew more complex; fixed in `list-blocks`/`app/setup/page.tsx` v0.9.1.

---

### [UI / Component Constraints] — Page-item rendering is one recursive function, not an inline single-level map
**Rule:** `renderItem()` in `app/setup/page.tsx` must stay a proper recursive function (calling itself for nested `columns` items), not get reverted to an inline `.map()` callback that can only handle one level.
**Why:** Nested columns (a column containing another column_list) are a real, observed page structure, not a hypothetical — an inline single-level map has no way to recurse into a column's own contents, which would silently drop or misrender anything nested more than one level deep.
**Example (correct):** `renderItem()` calls itself for each item inside a `columns` item's inner arrays.
**Example (wrong):** Inlining the render logic back into `blocks.map(item => { if (item.kind === 'columns') { ...but can't recurse... } })` — breaks as soon as a column contains another column_list.
**Source:** `app/setup/page.tsx` v0.9.1.

---

### [UI / Component Constraints] — Use `<style jsx global>`, not scoped `<style jsx>`, since rendering is split across helper functions
**Rule:** `app/setup/page.tsx`'s style block must stay `<style jsx global>`. Do not revert to scoped `<style jsx>` while `renderItem()` (or any other JSX-returning helper function extracted for recursion/reuse) exists.
**Why:** ⚠️ SILENT FAILURE, and a confusing one — scoped styled-jsx only reliably attaches its scoping class to JSX literals written directly in the component's own return statement. Elements returned by a separate helper function (like the recursive `renderItem()`, needed since v0.9.1 to render nested Notion columns) fall outside that scoping, so their styles silently don't apply at all — not just layout-related styles, ALL of them (colors, spacing, everything). This produced a confusing bug report ("columns don't work") that was actually a much bigger silent failure (nothing rendered by `renderItem()` was ever styled), only fully diagnosed by comparing an actual API response (proving the data/logic was correct) against a screenshot (proving the CSS wasn't applying at all).
**Example (correct):** `<style jsx global>{...}` — unscoped, applies by plain class name regardless of which function rendered the element.
**Example (wrong):** `<style jsx>{...}` (scoped) while any rendering logic lives in a helper function separate from the component's literal return statement.
**Source:** User-reported column rendering bug, root-caused via API response vs. screenshot comparison; fixed in `app/setup/page.tsx` v0.9.3.

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

### [API / External Integrations] — A blank Mapping cell means "leave unchanged," never "omit this column"
**Rule:** In a `Row Block ID` mapping row, a blank cell between two filled ones must be preserved as a `null` entry in `sourceCellRefs`/`values`, never filtered out of the array. Only trailing blanks (nothing meaningful after them) get trimmed. `syncOneMappedTableRow()` always fetches the row's current cells via `notion.blocks.retrieve()` first, then merges: any position with a real value overwrites, any `null`/missing position keeps the existing text. It can never send Notion a `cells` array shorter than the table's actual width.
**Why:** ⚠️ SILENT FAILURE turned into a loud one, which is the correct direction here — omitting a blank cell instead of preserving its position shifts every later column left, producing too few values for the row's width and triggering Notion's `"Number of cells in table row must match the table width"` validation error on every sync. This was an actual production bug, not a hypothetical.
**Example (correct):** Mapping row with `C5, , E5` → `sourceCellRefs = ["C5", null, "E5"]` → synced row overwrites columns 1 and 3, leaves column 2 exactly as it was in Notion.
**Example (wrong):** Filtering blanks before building `sourceCellRefs` (the original, buggy behavior) — `"C5, , E5"` becomes `["C5", "E5"]`, silently writing E5's value into column 2 instead of column 3, and failing Notion's width check if the table has more than 2 columns. Also wrong: sending a `cells` array shorter than the table's width and relying on Notion's own validation error instead of fetching+merging first — this was tried (v0.6.0) and doesn't allow partial updates at all, only full-width-or-nothing.
**Source:** User-reported production error; fixed in `lib/generateConnectorFiles.ts` / `route.ts` v0.8.2.
