# Patch Log

Reverse-chronological log of meaningful changes to Notion Updater.

---

### [1.0.1] — 2026-07-10
**Type:** Fix
**Scope:** `app/admin/page.tsx`, `app/setup/page.tsx`
**Summary:** User reported the flow "just stops" after clicking "Add connector" from the wizard. Root cause: the wizard's Step 3 opens `/admin` in a new tab (`target="_blank"`), so after saving there, the original wizard tab is untouched but nothing indicated that — it looked like a dead end instead of "switch back to the other tab."
**Details:**
- `app/admin/page.tsx`: tracks whether the page was opened with wizard prefill query params (`cameFromWizard`). After a successful save that originated that way, shows a green banner: "Connector added! ... switch back to your Setup Wizard tab ... and click Next." The flag resets after firing once, so it doesn't reappear for unrelated edits made later in the same session.
- `app/setup/page.tsx`: Step 3 now says outright, next to the button, that it opens in a new tab and to come back afterward — set expectations before the click, not just after.
**Breaking:** No.

---


**Type:** Feature
**Scope:** New: `app/admin/page.tsx`, `app/api/admin/connectors/route.ts`, `lib/github.ts`, `middleware.ts`. Updated: `app/setup/page.tsx` (Step 3), `.env.example`.
**Summary:** Added a password-gated `/admin` page for adding, editing, and removing connectors — commits directly to `connectors.json` via GitHub's Contents API, so registering a new connector no longer requires GitHub repo access. Chosen over a Google Sheet-based config store (the other option discussed) specifically to avoid standing up new Google Cloud infrastructure (service account, Sheets API) for a single-purpose config store.
**Details:**
- `lib/github.ts`: `fetchConnectorsFile()` reads `connectors.json` from GitHub's Contents API (base64-decoded, parsed, returned with its `sha`); `commitConnectorsFile()` writes a full replacement back, requiring that same `sha` — GitHub itself rejects the write with a 409 if the file changed since the read, which is the built-in protection against two people committing over each other. Repo/branch/path (`dan-abbott/Notion-Updater`, `main`, `connectors.json`) are hardcoded constants, not env vars, since this client only ever has one purpose.
- `app/api/admin/connectors/route.ts`: `GET` returns the current connector map; `PUT` upserts one connector (add or overwrite, same endpoint since the only difference is whether the ID already existed) and commits; `DELETE` removes one by ID (query param) and commits. Each commit gets a descriptive message ("Add/Update/Remove connector "..." via admin page") for a readable Git history.
- `middleware.ts`: gates `/admin/:path*` and `/api/admin/:path*` behind HTTP Basic Auth (`ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars) — proportional to this being a small internal tool for a handful of people, not a reason to build a full auth system. Fails closed: if `ADMIN_PASSWORD` isn't set, the check can never pass, so a missing env var means every request is rejected rather than accidentally left open.
- `app/admin/page.tsx`: lists existing connectors in a table (Edit/Remove per row), plus a form to add or edit one. Reads `?connectorId=&notionPageId=&appsScriptUrl=` query params to prefill the form — this is what Step 3 of the setup wizard now links to.
- Wizard's Step 3 now opens `/admin` (prefilled from earlier steps) as the primary path, with the raw JSON snippet + direct GitHub link kept as a manual fallback underneath.
- New required env vars: `GITHUB_TOKEN` (a GitHub PAT with Contents: Read and write on this repo — a fine-grained, repo-scoped token is recommended over a classic all-repo token), `ADMIN_USERNAME` (defaults to `admin`), `ADMIN_PASSWORD` (required; no default, fails closed if unset).
**Breaking:** No — additive. Existing connector registration by directly editing `connectors.json` in GitHub still works exactly as before; this is a second, easier path to the same file.

---


**Type:** Fix
**Scope:** `app/setup/page.tsx`
**Summary:** With columns now rendering correctly (v0.9.3), user reported the 4-column layout's chart boxes were too narrow to show both the "Sheet tab" and "Chart title" inputs side by side. Also requested the ability to resize the layout panel itself.
**Details:**
- `.chartBox` changed from a horizontal flex row to a vertical stack — the two inputs (sheet tab, chart title) now stack one above the other, each getting the box's full width, instead of splitting it side by side. This holds up regardless of how narrow a column gets (4+ columns, deeply nested, etc.).
- `.pageLayout` now has `resize: both`, giving it a native browser drag handle (bottom-right corner) to manually resize wider/taller. Switched from `max-height` to a fixed starting `height` (560px) plus `min-height`/`min-width`, since browser resize behavior expects an explicit starting size to adjust from.
**Breaking:** No — visual only.

---


**Type:** Fix
**Scope:** `app/setup/page.tsx`
**Summary:** Root cause found for the reported "columns aren't rendering side-by-side" bug — confirmed via the actual `list-blocks` API response that server-side detection was 100% correct (`kind: 'columns'` items present with exactly the right grouping). The bug was styled-jsx's scoped `<style jsx>` failing to apply to ANY element rendered by the extracted `renderItem()` helper function (not just columns — table header colors, chart box backgrounds, and every other v0.9.0-0.9.2 style were silently not applying either, confirmed by a follow-up screenshot showing plain unstyled output even after a hard refresh ruled out caching).
**Details:**
- Styled-jsx's default scoped mode only reliably attaches its scoping class to JSX literals written directly in the component's own return statement. `renderItem()` was extracted as a separate function (needed for recursion into nested columns, v0.9.1) — its returned JSX falls outside what the scoped styles reliably match.
- Changed `<style jsx>` to `<style jsx global>`, which outputs unscoped CSS that applies by class name regardless of which function produced the element. Safe here since `/setup` is the only page in this app and its class names don't need isolation from anything else.
**Breaking:** No — visual fix only; this is what makes v0.9.0 through v0.9.2's actual intended styling and column layout finally take effect.

---


**Type:** Fix
**Scope:** `app/setup/page.tsx`
**Summary:** User feedback on the page-mirroring layout (v0.9.0/0.9.1): too tight/dense, not enough visual color, and the overall page too narrow for the amount of information Step 2 shows. Widened the container and restyled tables/chart boxes/columns with more padding, softer colors, and card-style shadows instead of dashed borders.
**Details:**
- `.wrap` max-width increased from 860px to 1160px — prose (`.lede`/`.hint`) stays readable via its own `max-width: 64ch`, so only the wide Step 2 content actually benefits.
- `.pageLayout`, `.columnBox`, `.chartBox`, `.pageTable` restyled: card-shadow style instead of dashed borders, soft color-tinted backgrounds (light blue for chart boxes, light indigo/white alternating rows for tables), more padding throughout, rounded corners.
- `.pageLayout` now scrolls both directions (`overflow: auto`) instead of only vertically, since wide column layouts can exceed the container width.
- Investigating a separate report that side-by-side columns (v0.9.1) aren't visually appearing despite being deployed — root cause not yet confirmed as of this entry.
**Breaking:** No — visual only.

---


**Type:** Feature
**Scope:** `app/api/setup/list-blocks/route.ts`, `app/setup/page.tsx`
**Summary:** User's Notion page grows more complex (1 column → 2 → 4, nested), and the flat, depth-indented layout made it genuinely ambiguous which image/table belonged to which column. Added explicit `column_list`/`column` detection so the wizard renders actual side-by-side columns, matching the page structure exactly — including nested columns within columns.
**Details:**
- `list-blocks` restructured from a mutate-a-shared-array walk (`walkBlocks`) to a returning recursive parse (`parseChildren`), which is what makes clean recursion into columns possible — each column's contents come back as their own nested array rather than flattening into one shared list.
- Added a `{ kind: 'columns', id, depth, columns: PageBlockItem[][] }` item type: one inner array per Notion `column`, each containing that column's own items (which can themselves include more `columns` items, for nested column_lists — handled automatically since `parseChildren()` is the same function at every level).
- The wizard's rendering (`renderItem()`, now a proper recursive function rather than an inline one-level `.map()`) renders `columns` items as a flex row of bordered boxes, one per column, each recursively rendering its own contents — so a 4-column section in Notion renders as 4 side-by-side boxes in the wizard, and a nested column inside one of those renders as further side-by-side boxes within that box.
**Breaking:** No — pages with no columns render identically to before; this only adds handling for a structure that was previously silently flattened.

---


**Type:** Feature
**Scope:** `app/api/setup/list-blocks/route.ts`, `app/setup/page.tsx`
**Summary:** Replaced the flat, block-ID-labeled list in Step 2 with a layout that mirrors the actual Notion page — real HTML tables with inputs aligned directly under each column, headings/paragraphs as read-only context, images as inline chart-input boxes. Block IDs are no longer shown anywhere in the UI (still used internally, just not displayed).
**Details:**
- `list-blocks` no longer flattens tables into individual `table_row` entries. It now returns a discriminated union: `{ kind: 'simple', id, type, depth, preview }` for headings/paragraphs/images/etc., and `{ kind: 'table', id, depth, columns, hasRealHeader, rows: [{ id, cells }] }` for tables — one structured item per table, with real header labels (from the table's actual header row, or generic "Column N" labels if it has none) and every data row's current cell text included for context.
- The wizard renders this directly as a page: headings/paragraphs as plain read-only text (empty paragraphs skipped as pure visual noise), images as a bordered box with inline "Sheet tab" / "Chart title" inputs, and tables as real `<table>` elements — a header row showing the actual Notion column labels, plus one small "Tab" input column and one input per real column, all rendered directly under their matching header.
- Each table cell's input placeholder shows the CURRENT Notion value (e.g. `now: 21/88%`) rather than a generic example — this replaces needing a block ID to identify which row is which; the current content itself is the identifier.
- Removed the explicit "Add as chart"/"Add as table row" toggle buttons entirely — every image and table row is always directly editable. An entry only counts toward the generated mapping if its fields are actually filled in (unchanged from the existing filter logic), so leaving something blank has always been equivalent to "not selected."
- Table row state changed from a single free-text comma-separated string to a structured per-column array (`cellRefs: string[]`, one slot per real column) — since the grid is now rendered with one input per actual column, there's no more comma-parsing or trailing-blank-trimming needed on the client; the array is already exactly the right width by construction. (The Apps Script/backend side still needs to support arbitrary hand-edited Mapping sheets independent of the wizard, so its blank-handling logic there is unchanged.)
**Breaking:** No — the Mapping sheet output format and backend behavior are unchanged; this is purely a `/setup` UI/UX change.

---


**Type:** Fix
**Scope:** `app/setup/page.tsx`
**Summary:** User reported `Notion.gs` including a call to `generateMetricsRemote()` even with the pre-export function field left empty. The underlying generator (`generateNotionGsCode()`) was verified correct for `undefined`/`''`/whitespace-only input — the actual bug was stale UI state: editing the pre-export field after already clicking "Generate Notion.gs" once left the previously generated code on screen, unchanged, so anyone who edited the field without clicking Generate again would keep looking at (and could copy/deploy) output that didn't reflect the field's current value.
**Details:**
- The pre-export function name input's `onChange` now clears both `notionGsCode` and `appsScriptUrl` immediately. This forces an explicit re-generation before the "Next" button re-enables (it's gated on `appsScriptUrl` being non-empty), rather than letting stale output linger silently.
**Breaking:** No — purely a UI correctness fix.

---


**Type:** Fix
**Scope:** `lib/generateConnectorFiles.ts`, `apps-script/Code.gs`, `app/api/notion-sync/[connectorId]/route.ts`, `app/setup/page.tsx`
**Summary:** User reported `"Number of cells in table row must match the table width of the parent table"` from Notion's API. Root cause: leaving a Mapping sheet cell blank to "skip" a column made `readMappingSheet()` omit it from the list entirely, shifting every later column left and producing too few values for the row's actual width. Fixed by treating a blank as "leave this column's current value unchanged" instead of "remove it from the list."
**Details:**
- `readMappingSheet()` (embedded in the generated `Notion.gs`) now preserves blank cell positions as `null` rather than filtering them out — only *trailing* blanks (nothing meaningful after them) get trimmed, so filler commas aren't needed past the last column actually specified.
- `exportMappedDataAsJson()` resolves a `null` ref straight to a `null` value (skip signal) instead of trying to read it as a cell reference.
- `syncOneMappedTableRow()` (middleware) now fetches the row's current cells via `notion.blocks.retrieve()` first, then merges: any position with a real value overwrites, any `null`/missing position keeps the existing text. This is what actually satisfies Notion's exact-column-count requirement while still allowing partial updates — costs one extra API call per row, negligible at this system's scale (tens of rows, not thousands).
- Wizard's table-row input and its client-side parser (`parseSourceCells()`) updated to match: a blank between commas (e.g. `C5, , E5`) is preserved as a skip, not silently dropped.
- Regenerated `apps-script/Code.gs` (reference copy) and the Portfolio Tracker's `Notion.gs` with this fix.
**Breaking:** No — existing Mapping sheets with no blank cells behave identically. Sheets that previously relied on (accidentally) filtered blanks now behave correctly instead of erroring.

---


**Type:** Feature
**Scope:** `lib/notion.ts`, `app/api/setup/list-blocks/route.ts`, `app/api/notion-sync/[connectorId]/route.ts`, `app/setup/page.tsx`
**Summary:** Notion's API returns the same generic "object not found" error whether a page genuinely doesn't exist or it exists but was never shared with the integration — the latter being, by far, the most common cause when someone's just set up a new connector. Added specific detection for this, plus an explicit reminder in the wizard, so this doesn't cost anyone debugging time.
**Details:**
- `lib/notion.ts`: added `explainNotionError(error)`, using `@notionhq/client`'s `isNotionClientError`/`APIErrorCode.ObjectNotFound` to detect this specific case and return a message naming the actual fix (Notion page → ••• menu → Connections → add the integration) rather than a bare 404.
- Used in `list-blocks`'s catch block (where this is most likely to be hit for the first time, during initial setup) and in the sync route's outer catch (which wraps every Notion API call in `runSyncPipeline()`, so any connector — wizard-built or not — gets the same clear message if its page ever loses its integration connection).
- Added an explicit reminder in the wizard's Step 2, right above the page-paste input, telling people to share the page with the integration before listing blocks.
**Breaking:** No — purely additive error-message clarity; behavior is otherwise unchanged.

---


**Type:** Feature / Breaking
**Scope:** `lib/generateConnectorFiles.ts`, `apps-script/Code.gs`, `app/setup/page.tsx`, new `app/api/setup/generate-script`, new `app/api/setup/generate-mapping`, removed `app/api/setup/generate`. Paired change: `Notion.gs` v0.6.0 in the Portfolio Tracker repo.
**Summary:** Two user-requested changes: (1) Mapping sheet mappings can now each pull from a different sheet tab, instead of every connector being limited to one shared "Data Source Tab"; (2) the setup wizard restructured into an explicit 5-step progression, with chart/table-row details filled in inline right where each block is selected, instead of a separate step below.
**Details:**
- **Multi-sheet mappings:** every row in the Mapping sheet now names its own tab (`Row Block ID` mappings: column C = tab, D+ = source cells; `Block ID` chart mappings: column C = tab, D = chart title). The old single `B1` "Data Source Tab" cell is gone entirely. `exportMappedDataAsJson()`/`exportMappedCharts()` (both regenerated via `lib/generateConnectorFiles.ts`) now resolve each mapping's sheet by name per-row (cached, so repeated references to the same tab don't re-look-it-up), and group chart mappings by tab so each tab's chart-title lookup only happens once regardless of how many chart mappings reference it.
- **⚠️ Breaking for existing connectors:** any live Mapping sheet still using the old `B1`-only layout must be migrated — add a "Sheet tab" column (C) to every existing `Row Block ID`/`Block ID` row, shifting table rows' source cells one column right (now starting at D instead of C). The Portfolio Tracker's own Mapping sheet needs this migration done by hand before its next sync.
- **Wizard restructure:** `/setup` is now an explicit 5-step flow — (1) generate `Notion.gs` + deploy + capture the Web App URL, (2) list Notion blocks, tag charts/table rows inline (each block's "Add as..." button expands its own inline tab-name/title or tab-name/cells inputs directly under that block, rather than a separate list further down the page), and generate Mapping rows, (3) the `connectors.json` entry to add (with a direct link to the file in GitHub), (4) the Notion button's webhook URL, (5) a test checklist.
- Split the old single `/api/setup/generate` route into `/api/setup/generate-script` (step 1, depends only on the optional pre-export function name) and `/api/setup/generate-mapping` (step 2, depends only on the collected chart/table-row mappings) — matches the wizard no longer needing both pieces of information at the same time.
- Added `lib/randomConnectorId.ts`: auto-fills Step 1's connector ID with a random adjective-noun pair (e.g. `amber-otter`), freely editable — removes the "name it right now or leave it blank" friction point without making the ID meaningful.
- Step 3 and 4 now generate real, copy-ready output instead of placeholders: the `connectors.json` snippet uses the actual page ID/script URL/connector ID collected in earlier steps, links directly to `https://github.com/dan-abbott/Notion-Updater/blob/main/connectors.json`, and the button URL uses the actual deployed base (`notion-updater-pi.vercel.app`).
**Breaking:** Yes — see the Mapping sheet migration note above. This is a data-layout change to every existing connector's Mapping sheet, not just new ones.

---


**Type:** Feature
**Scope:** New: `connectors.json`, `lib/connectors.ts`, `lib/notion.ts`. Moved: `app/api/notion-sync/route.ts` → `app/api/notion-sync/[connectorId]/route.ts`.
**Summary:** Generalized the middleware from a single hardcoded Notion page + Apps Script pair to supporting many independent connectors, each with its own page and script, addressed by URL. Anticipated to scale to ~30 connectors.
**Details:**
- `connectors.json` (repo root): one entry per connector, `{ notionPageId, appsScriptUrl }`. `NOTION_TOKEN` stays a single shared env var — per user decision, it never varies per connector.
- `lib/connectors.ts`: `getConnectorConfig(connectorId)` looks up an entry, throwing a clear error (listing known connector IDs) if the requested one doesn't exist.
- `lib/notion.ts`: the shared `Client` instance, extracted so both the sync route and the new setup-wizard routes (see below) use the same one.
- The sync route is now `app/api/notion-sync/[connectorId]/route.ts` — each connector's Notion button points at its own URL (`/api/notion-sync/<id>`), and the route looks up that connector's page/script pair at request time instead of reading fixed env vars.
- `NOTION_PAGE_ID` / `GOOGLE_APPS_SCRIPT_URL` env vars are retired — removed from `.env.example`.
- Renamed `triggerGenerateMetrics()` → `triggerPreExport()` and generalized the Apps Script action from `?action=generateMetrics` to `?action=runPreExport` (see `Notion.gs`'s corresponding generalization, Portfolio Tracker repo v0.5.0) — this terminology was overly specific to the Portfolio Tracker's own pipeline and needed to describe *any* connector's optional pre-export step, not just that one.
**Breaking:** Yes — every existing connector must get an entry in `connectors.json`, and its Notion button's webhook URL must be updated to include the connector ID. The single-page env-var configuration this replaced no longer works.

---

### [0.7.1] — 2026-07-10
**Type:** Feature
**Scope:** New: `app/setup/page.tsx`, `app/api/setup/list-blocks/route.ts`, `app/api/setup/generate/route.ts`, `lib/generateConnectorFiles.ts`, `lib/notionId.ts`.
**Summary:** Added a setup wizard (`/setup`) that walks through connecting a new Notion page to a new Google Sheet without needing to hand-write `Notion.gs` or hand-assemble the Mapping sheet — addresses the manual-mapping burden flagged as the worst-scaling part of onboarding a new connector (see `ADDING_A_CONNECTOR.md`).
**Details:**
- `lib/notionId.ts`: `extractNotionId()` pulls a Notion page/block ID out of either a raw ID or a pasted page URL (with or without a `#block-id` fragment).
- `app/api/setup/list-blocks/route.ts`: given a page URL/ID, recursively walks the block tree (descending into every `table` block specifically, since `table_row` children are the whole reason this endpoint is more useful than Notion's own "copy link" UI for individual rows) and returns a flat, depth-tagged list of `{ id, type, preview }` for every block. This is the core value of the wizard — Notion's UI won't reliably surface a table row's own block ID, but the API returns it for free.
- `lib/generateConnectorFiles.ts`: `generateNotionGsCode()` produces the full `Notion.gs` text (mirroring `apps-script/Code.gs` in this repo), templating `runPreExportStep()`'s body with either a literal call to a given function name or a no-op success — deliberately NOT runtime reflection (`this[name]()`), since a plain generated function call is more robust across Apps Script's execution model and easier for a human to read afterward. `generateMappingRows()` produces the Mapping sheet's exact row layout, ready to paste as TSV.
- `app/api/setup/generate/route.ts`: takes the wizard's collected chart/table-row mappings plus a data source tab name and optional pre-export function name, and returns the generated `Notion.gs` text, Mapping sheet rows, and a plain-language instructions list (including the exact `connectors.json` entry to add, if a connector ID was given).
- `app/setup/page.tsx`: the wizard UI itself — paste a page, list its blocks, tag image/table_row blocks as chart/table-row mappings inline, fill in connector settings, generate, copy the results. Deliberately plain/functional styling (internal tool, not a customer-facing surface) rather than a full visual-identity pass.
- **Explicit scope boundary, per user instruction:** the wizard NEVER generates page-specific automation scripts like `Data Acquisition.gs`/`portfolio.gs`. The "pre-export function" field only accepts the *name* of a function assumed to already exist in the target Apps Script project — the wizard generates a call to it, never its logic.
**Breaking:** No — purely additive; existing connectors are unaffected.

---


**Type:** Fix
**Scope:** `app/api/notion-sync/route.ts`
**Summary:** Production run returned 0 charts with no visible cause in the Vercel logs. Paired with `Notion.gs` v0.4.1 adding a `warnings` array to the script's response — this update makes `fetchMappedDataFromScript()` log those warnings directly, so a chart-title mismatch or malformed mapping row is visible in the same log stream as everything else, not just in the Apps Script's separate Executions log.
**Details:**
- `fetchMappedDataFromScript()` now checks for `data.warnings` and logs each one with a `[NOTION SYNC] ⚠️` prefix, right where the chart/table-row counts are already logged.
**Breaking:** No.

---


**Type:** Refactor
**Scope:** `app/api/notion-sync/route.ts` (requires paired changes in the Portfolio Tracker Apps Script project — see that repo's PATCH_LOG.md v0.4.0)
**Summary:** Retired ALL page-text anchor matching for charts and tables (`[Chart] Title`, `[Table] Label`), replacing it with a manually-maintained "Mapping" sheet in Google Sheets that pairs exact Notion block IDs with their data sources. User's motivation: Notion gives very little control over making anchor text small/unobtrusive, and wanted zero visible plumbing on the page.
**Details:**
- Removed `findAllChartAnchors()`, `findAllTableAnchors()`, `ANCHOR_PREFIX`, `TABLE_ANCHOR_PREFIX`, and all title/label-matching logic (unmatched-anchor tracking, chart-vs-table pairing, insert-vs-update branching for charts). The `[Status]` block is now the ONLY thing still found by text search on the page — everything else is addressed directly by block ID.
- `fetchMappedDataFromScript()` replaces `fetchChartsFromScript()`/`fetchTablesFromScript()`: one call to the Apps Script (no `?action=` needed — this is now the default action) returns `{ charts: [{ blockId, imageBase64 }], tableRows: [{ blockId, values }] }`, fully resolved and ready to write.
- `syncOneMappedChart()` replaces `syncOneChart()`: always an update (never an insert) since the block ID came from an existing Notion block — this eliminates the whole "does an image block already exist after the anchor" check entirely.
- `syncOneMappedTableRow()` replaces `syncOneTable()`: a single `notion.blocks.update()` per row by block ID. No more table-width pre-validation, no more "find the table, preserve the header, delete+reinsert data rows" dance — Notion's own API validates column count and throws if it doesn't match, which surfaces per-row via `Promise.allSettled` same as before.
**Breaking:** Yes, in the sense that this is a different system, not a compatible extension — any page still using `[Chart]`/`[Table]` anchor text is inert now; every chart and table row must be re-registered in the Mapping sheet with real Notion block IDs before this version will do anything for it. See the paired Apps Script repo's invariants for the Mapping sheet's exact expected layout.

---


**Type:** Feature
**Scope:** `app/api/notion-sync/route.ts` (requires paired changes in the Portfolio Tracker Apps Script project — see that repo's PATCH_LOG.md v0.3.4)
**Summary:** Added the ability to mirror numeric data from named ranges in Google Sheets into native Notion table blocks, following the same anchor-block convention already used for charts — one row per studio, header preserved, row count free to grow/shrink.
**Details:**
- Added `findAllTableAnchors()`: same recursive-search pattern as `findAllChartAnchors()`, but looks for `[Table] <label>` anchors and requires the immediately-following sibling to be an actual `table` block (skips with a warning, not an error, if it isn't — the anchor might just be misplaced).
- Added `fetchTablesFromScript()`: calls the Apps Script with `?action=exportTables`, returns `{ label, rows: string[][] }[]` — each `rows` array is ONLY the data rows for that table (no header).
- Added `syncOneTable()`: retrieves the target table block's `table_width`, validates every incoming row has exactly that many columns (throws a clear, table-specific error if not), then **always preserves the table's first existing row untouched** (the header) and replaces every row after it — delete all old data rows, append new ones built from the named range. This is what lets studio count change over time without needing column-meaning awareness on the middleware side.
- `runSyncPipeline()` now runs chart sync, then table sync, with its own status updates at each stage, and a combined final status reflecting total chart + table failures.
- Anchors with no matching named range (and vice versa) are logged and skipped, same non-fatal-mismatch philosophy as chart anchors.
**Breaking:** No — additive. A page with no `[Table]` anchors behaves exactly as before (table sync step is a no-op, no additional API calls made). Requires the paired Apps Script change (`?action=exportTables`) to actually return data — without it, `fetchTablesFromScript()` throws and table sync fails as a whole (but this only happens if `[Table]` anchors are present).

---


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
