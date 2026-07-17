'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { generateRandomConnectorId } from '@/lib/randomConnectorId';
import { extractGoogleSheetId } from '@/lib/googleSheetId';

const BASE_URL = 'notion-updater-pi.vercel.app';
const CONNECTORS_JSON_URL = 'https://github.com/dan-abbott/Notion-Updater/blob/main/connectors.json';

type SimpleBlockItem = {
  kind: 'simple';
  id: string;
  type: string;
  depth: number;
  preview: string;
};

type TableBlockItem = {
  kind: 'table';
  id: string;
  depth: number;
  columns: string[];
  hasRealHeader: boolean;
  rows: { id: string; cells: string[] }[];
};

type ColumnsBlockItem = {
  kind: 'columns';
  id: string;
  depth: number;
  columns: PageBlockItem[][];
};

type PageBlockItem = SimpleBlockItem | TableBlockItem | ColumnsBlockItem;

type ChartDetails = { tabName: string; chartTitle: string };
type TableRowDetails = { tabName: string; cellRefs: string[] };

// Minimal client-side mirror of lib/notionId.ts's extraction logic — just
// string parsing, safe to duplicate rather than round-trip to the server
// for something this cheap.
function extractNotionIdClient(input: string): string | null {
  const trimmed = input.trim();
  const hashIndex = trimmed.indexOf('#');
  const candidates: string[] = [];
  if (hashIndex !== -1) candidates.push(trimmed.slice(hashIndex + 1));
  candidates.push(trimmed);

  for (const candidate of candidates) {
    const cleaned = candidate.split('?')[0];
    const match = cleaned.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (match) {
      const hex = match[1].replace(/-/g, '');
      if (hex.length === 32) {
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    }
  }
  return null;
}

export default function SetupPage() {
  return (
    <Suspense fallback={<main className="wrap"><p>Loading…</p></main>}>
      <SetupPageContent />
    </Suspense>
  );
}

function SetupPageContent() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [isEditMode, setIsEditMode] = useState(false);

  // Step 1 — script setup
  const [connectorId, setConnectorId] = useState(() => generateRandomConnectorId());
  const [preExportFunctionName, setPreExportFunctionName] = useState('');
  const [notionGsCode, setNotionGsCode] = useState<string | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [appsScriptUrl, setAppsScriptUrl] = useState('');
  const [sheetId, setSheetId] = useState('');

  // Step 2 — Notion page + block selection
  const [pageInput, setPageInput] = useState('');
  const [blocks, setBlocks] = useState<PageBlockItem[] | null>(null);
  const [loadingBlocks, setLoadingBlocks] = useState(false);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [chartDetails, setChartDetails] = useState<Record<string, ChartDetails>>({});
  const [tableRowDetails, setTableRowDetails] = useState<Record<string, TableRowDetails>>({});
  const [mappingRows, setMappingRows] = useState<string[][] | null>(null);
  const [generatingMapping, setGeneratingMapping] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1500);
    });
  }

  function mappingRowsAsTsv(rows: string[][]): string {
    return rows.map(row => row.join('\t')).join('\n');
  }

  // --- Step 1 actions ---

  async function handleGenerateScript() {
    setGeneratingScript(true);
    setScriptError(null);
    try {
      const res = await fetch('/api/setup/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preExportFunctionName: preExportFunctionName || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate Notion.gs.');
      setNotionGsCode(data.notionGsCode);
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setGeneratingScript(false);
    }
  }

  // --- Step 2 actions ---

  // Walks the listed blocks (recursing into 'columns') to find every real
  // block ID currently on the page, plus each table row's current column
  // count — used to filter a previously-saved mapping down to entries that
  // still exist, and to size cellRefs correctly even if a table's column
  // count changed since the mapping was last saved.
  function collectBlockInfo(items: PageBlockItem[]): { blockIds: Set<string>; rowNumCols: Map<string, number> } {
    const blockIds = new Set<string>();
    const rowNumCols = new Map<string, number>();

    function walk(list: PageBlockItem[]) {
      for (const item of list) {
        blockIds.add(item.id);
        if (item.kind === 'table') {
          for (const row of item.rows) {
            blockIds.add(row.id);
            rowNumCols.set(row.id, item.columns.length);
          }
        } else if (item.kind === 'columns') {
          for (const col of item.columns) walk(col);
        }
      }
    }
    walk(items);
    return { blockIds, rowNumCols };
  }

  // Loads a connector's previously-saved mapping (from its repo JSON file)
  // and pre-populates chartDetails/tableRowDetails with whatever still
  // matches a real block on the page — this is what makes "Edit mapping"
  // an actual edit instead of starting blank. Entries whose block no
  // longer exists (e.g. the row was deleted in Notion) are silently
  // dropped rather than kept around as orphaned state.
  async function loadExistingMapping(mappingConnectorId: string, items: PageBlockItem[]) {
    try {
      const res = await fetch(`/api/setup/mapping?connectorId=${encodeURIComponent(mappingConnectorId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load existing mapping.');

      const { blockIds, rowNumCols } = collectBlockInfo(items);

      const newChartDetails: Record<string, ChartDetails> = {};
      for (const chart of data.charts || []) {
        if (blockIds.has(chart.blockId)) {
          newChartDetails[chart.blockId] = { tabName: chart.tabName, chartTitle: chart.chartTitle };
        }
      }
      setChartDetails(newChartDetails);

      const newTableRowDetails: Record<string, TableRowDetails> = {};
      for (const row of data.tableRows || []) {
        if (blockIds.has(row.blockId)) {
          const numCols = rowNumCols.get(row.blockId) ?? row.sourceCells.length;
          const cellRefs = Array.from({ length: numCols }, (_, i) => row.sourceCells[i] ?? '');
          newTableRowDetails[row.blockId] = { tabName: row.tabName, cellRefs };
        }
      }
      setTableRowDetails(newTableRowDetails);
    } catch (err) {
      // Non-fatal by design — worst case, this session starts from a blank
      // mapping instead of the previous one; still fully usable, just
      // without old entries pre-filled.
      console.error('Could not load existing mapping:', err);
    }
  }

  async function listBlocksFor(idOrUrl: string, mappingConnectorId?: string) {
    setLoadingBlocks(true);
    setBlocksError(null);
    setBlocks(null);
    setChartDetails({});
    setTableRowDetails({});
    setMappingRows(null);
    try {
      const res = await fetch('/api/setup/list-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: idOrUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not list blocks for that page.');
      setBlocks(data.items);

      if (mappingConnectorId) {
        await loadExistingMapping(mappingConnectorId, data.items);
      }
    } catch (err) {
      setBlocksError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingBlocks(false);
    }
  }

  async function handleListBlocks() {
    await listBlocksFor(pageInput);
  }

  // Arriving from the admin page's "Edit mapping" link: prefill everything
  // already known about this connector and jump straight to Step 2 with
  // blocks already listed — no need to redo Step 1 (the script/deployment
  // hasn't changed) just to get to the mapping step.
  useEffect(() => {
    const prefillConnectorId = searchParams.get('connectorId');
    const prefillPageId = searchParams.get('notionPageId');
    const prefillScriptUrl = searchParams.get('appsScriptUrl');
    const prefillSheetId = searchParams.get('sheetId');

    if (prefillConnectorId) setConnectorId(prefillConnectorId);
    if (prefillScriptUrl) setAppsScriptUrl(prefillScriptUrl);
    if (prefillSheetId) setSheetId(prefillSheetId);

    if (prefillPageId) {
      setIsEditMode(true);
      setPageInput(prefillPageId);
      setStep(2);
      listBlocksFor(prefillPageId, prefillConnectorId || undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateChart(blockId: string, patch: Partial<ChartDetails>) {
    setChartDetails(prev => ({
      ...prev,
      [blockId]: { tabName: prev[blockId]?.tabName ?? '', chartTitle: prev[blockId]?.chartTitle ?? '', ...patch },
    }));
  }

  function updateTableRowTab(rowId: string, numCols: number, tabName: string) {
    setTableRowDetails(prev => ({
      ...prev,
      [rowId]: { tabName, cellRefs: prev[rowId]?.cellRefs ?? Array(numCols).fill('') },
    }));
  }

  function updateTableRowCell(rowId: string, numCols: number, colIndex: number, value: string) {
    setTableRowDetails(prev => {
      const existing = prev[rowId] ?? { tabName: '', cellRefs: Array(numCols).fill('') };
      const cellRefs = [...existing.cellRefs];
      cellRefs[colIndex] = value;
      return { ...prev, [rowId]: { ...existing, cellRefs } };
    });
  }

  async function handleGenerateMapping() {
    setGeneratingMapping(true);
    setMappingError(null);
    try {
      const charts = Object.entries(chartDetails)
        .filter(([, d]) => d.tabName.trim() && d.chartTitle.trim())
        .map(([blockId, d]) => ({ blockId, tabName: d.tabName.trim(), chartTitle: d.chartTitle.trim() }));
      const tableRows = Object.entries(tableRowDetails)
        .filter(([, d]) => d.tabName.trim() && d.cellRefs.some(c => c.trim()))
        .map(([blockId, d]) => ({
          blockId,
          tabName: d.tabName.trim(),
          // Each entry lines up with a real column position (built directly
          // from the rendered grid, one input per column) — a blank input
          // means "leave that column unchanged" in Notion, sent as null.
          sourceCells: d.cellRefs.map(c => (c.trim() ? c.trim() : null)),
        }));

      const res = await fetch('/api/setup/generate-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: connectorId.trim(), charts, tableRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate Mapping rows.');
      setMappingRows(data.mappingRows);

      // Commit this as the connector's new complete mapping state — what's
      // in chartDetails/tableRowDetails right now already represents
      // everything this connector should have mapped (old entries loaded
      // in via "Edit mapping," plus anything added/changed this session),
      // not just what's new. A failure here is surfaced but doesn't block
      // showing the generated rows — the person can still paste those in
      // manually even if the save-for-next-time didn't succeed.
      try {
        const saveRes = await fetch('/api/setup/mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectorId: connectorId.trim(), charts, tableRows }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error || 'Could not save mapping state.');
      } catch (saveErr) {
        setMappingError(
          `Rows generated, but saving this as the connector's tracked mapping failed: ${
            saveErr instanceof Error ? saveErr.message : 'Unknown error'
          }. You can still paste the rows below — future "Edit mapping" visits just won't see this session's changes.`
        );
      }
    } catch (err) {
      setMappingError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setGeneratingMapping(false);
    }
  }

  const notionPageId = extractNotionIdClient(pageInput);
  const cleanedSheetId = extractGoogleSheetId(sheetId) || sheetId;
  const connectorsJsonSnippet = JSON.stringify(
    {
      [connectorId || '<connector-id>']: {
        notionPageId: notionPageId || '<notion-page-id>',
        appsScriptUrl: appsScriptUrl || '<apps-script-url>',
        ...(cleanedSheetId ? { sheetId: cleanedSheetId } : { sheetId: '<google-sheet-id>' }),
      },
    },
    null,
    2
  );
  const buttonUrl = `https://${BASE_URL}/api/notion-sync/${connectorId || '<connector-id>'}`;

  // Renders one page item. Defined inside the component so it can read
  // chartDetails/tableRowDetails and call the update* functions directly.
  // Recurses for 'columns' items — each Notion column can itself contain
  // more columns (nested column_lists), which this handles naturally by
  // just calling itself on each inner array.
  function renderItem(item: PageBlockItem): JSX.Element | null {
    if (item.kind === 'columns') {
      return (
        <div key={item.id} className="columnsRow" style={{ marginLeft: `${item.depth * 20}px` }}>
          {item.columns.map((colItems, i) => (
            <div key={i} className="columnBox">
              {colItems.map(sub => renderItem(sub))}
            </div>
          ))}
        </div>
      );
    }

    if (item.kind === 'table') {
      return (
        <table key={item.id} className="pageTable" style={{ marginLeft: `${item.depth * 20}px` }}>
          <thead>
            <tr>
              <th className="tabHeader">Tab</th>
              {item.columns.map((col, i) => (
                <th key={i}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {item.rows.map(row => {
              const numCols = item.columns.length;
              const details = tableRowDetails[row.id];
              return (
                <tr key={row.id}>
                  <td className="tabCell">
                    <input
                      type="text"
                      placeholder="Tab"
                      value={details?.tabName ?? ''}
                      onChange={e => updateTableRowTab(row.id, numCols, e.target.value)}
                    />
                  </td>
                  {row.cells.map((currentValue, colIndex) => (
                    <td key={colIndex}>
                      <input
                        type="text"
                        placeholder={currentValue ? `now: ${currentValue}` : 'e.g. C5'}
                        value={details?.cellRefs?.[colIndex] ?? ''}
                        onChange={e => updateTableRowCell(row.id, numCols, colIndex, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }

    // item.kind === 'simple'
    if (item.type === 'image') {
      const details = chartDetails[item.id];
      return (
        <div key={item.id} className="chartBox" style={{ marginLeft: `${item.depth * 20}px` }}>
          <span className="chartIcon">🖼</span>
          <input
            type="text"
            placeholder="Sheet tab"
            value={details?.tabName ?? ''}
            onChange={e => updateChart(item.id, { tabName: e.target.value })}
          />
          <input
            type="text"
            placeholder="Exact chart title in Google Sheets"
            value={details?.chartTitle ?? ''}
            onChange={e => updateChart(item.id, { chartTitle: e.target.value })}
          />
        </div>
      );
    }

    if (item.type === 'heading_1' || item.type === 'heading_2' || item.type === 'heading_3') {
      const Tag = item.type === 'heading_1' ? 'h2' : item.type === 'heading_2' ? 'h3' : 'h4';
      return (
        <Tag key={item.id} className="pageHeading" style={{ marginLeft: `${item.depth * 20}px` }}>
          {item.preview || '(empty heading)'}
        </Tag>
      );
    }

    if (item.type === 'paragraph') {
      if (!item.preview) return null; // skip empty paragraphs — pure visual noise
      return (
        <p key={item.id} className="pageText" style={{ marginLeft: `${item.depth * 20}px` }}>
          {item.preview}
        </p>
      );
    }

    // Other block types (dividers, buttons, etc.) aren't fillable and
    // aren't useful context — skip rendering.
    return null;
  }

  return (
    <main className="wrap">
      <h1>Set up a new connector</h1>
      <p className="lede">
        Connect a Notion page to a Google Sheet. Five steps: deploy the script, map your data, register the
        connector, wire up the Notion button, then test.
      </p>
      <p className="stepIndicator">Step {step} of 5</p>

      {step === 1 && (
        <section className="step">
          <h2>1. Deploy the script</h2>

          <label className="field">
            Connector ID
            <div className="row">
              <input type="text" value={connectorId} onChange={e => setConnectorId(e.target.value)} />
              <button className="small ghost" onClick={() => setConnectorId(generateRandomConnectorId())}>
                Randomize
              </button>
            </div>
            <span className="hint">A short, URL-safe name for this connector. Auto-generated — change it if you want something more memorable.</span>
          </label>

          <label className="field">
            Pre-export function name (optional)
            <input
              type="text"
              placeholder="e.g. generateMetricsRemote — leave blank if none"
              value={preExportFunctionName}
              onChange={e => {
                setPreExportFunctionName(e.target.value);
                // Clear any previously generated code AND the pasted Web App
                // URL — both are now stale: the code no longer matches what
                // was last deployed, and the URL corresponds to that old
                // deployment until it's redeployed and re-pasted.
                setNotionGsCode(null);
                setAppsScriptUrl('');
              }}
            />
            <span className="hint">Must already exist in this Sheet's Apps Script project — this only generates the call to it.</span>
          </label>

          <label className="field">
            Google Sheet URL or ID
            <input
              type="text"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={sheetId}
              onChange={e => setSheetId(e.target.value)}
            />
            <span className="hint">
              Just for a clear link in <code>connectors.json</code> — nothing in the sync itself reads this (the deployed
              script is already tied to one specific Sheet).
            </span>
          </label>

          <button onClick={handleGenerateScript} disabled={generatingScript}>
            {generatingScript ? 'Generating…' : 'Generate Notion.gs'}
          </button>
          {scriptError && <p className="error">{scriptError}</p>}

          {notionGsCode && (
            <>
              <div className="resultBlock">
                <div className="resultHeader">
                  <h3>Notion.gs</h3>
                  <button className="small" onClick={() => copyToClipboard(notionGsCode, 'code')}>
                    {copiedKey === 'code' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre>{notionGsCode}</pre>
              </div>

              <ol className="instructionsList">
                <li>Paste this into your Google Sheet's Apps Script editor (Extensions → Apps Script).</li>
                <li>Deploy it: Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.</li>
                <li>Copy the resulting Web App URL and paste it below.</li>
              </ol>

              <label className="field">
                Apps Script Web App URL
                <input
                  type="text"
                  placeholder="https://script.google.com/macros/s/.../exec"
                  value={appsScriptUrl}
                  onChange={e => setAppsScriptUrl(e.target.value)}
                />
              </label>

              <button onClick={() => setStep(2)} disabled={!appsScriptUrl.trim()}>
                Next: Map your data
              </button>
            </>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="step">
          <h2>2. Connect the Notion page &amp; map your data</h2>
          {isEditMode && (
            <p className="editBanner">
              Editing connector <strong>{connectorId}</strong> — blocks are already listed, and previously-mapped
              fields are pre-filled below. Change, remove, or add fields as needed, then generate — this replaces
              the connector's ENTIRE mapping, not just what you touch this session.
            </p>
          )}
          <p className="hint">
            First, make sure this page is shared with the integration: open it in Notion → <strong>•••</strong>{' '}
            menu (top right) → <strong>Connections</strong> → add the integration this app uses. Without this,
            listing blocks (and every future sync) fails with a "not found" error even though the page ID is correct.
          </p>
          <p className="hint">Then paste the page's URL or ID and list its blocks.</p>
          <div className="row">
            <input
              type="text"
              placeholder="https://www.notion.so/your-workspace/Page-Title-abc123..."
              value={pageInput}
              onChange={e => setPageInput(e.target.value)}
            />
            <button onClick={handleListBlocks} disabled={!pageInput.trim() || loadingBlocks}>
              {loadingBlocks ? 'Listing blocks…' : 'List blocks'}
            </button>
          </div>
          {blocksError && <p className="error">{blocksError}</p>}

          {blocks && (
            <>
              <p className="hint">
                This mirrors your Notion page. Fill in a <strong>sheet tab</strong> and <strong>chart title</strong> under any
                image to sync a chart into it. For tables, fill in a <strong>sheet cell</strong> under each column you want
                synced — leave a cell blank to leave that column unchanged. Nothing you leave blank gets included.
              </p>
              <div className="pageLayout">{blocks.map(item => renderItem(item))}</div>

              <button
                onClick={handleGenerateMapping}
                disabled={generatingMapping || (Object.keys(chartDetails).length === 0 && Object.keys(tableRowDetails).length === 0)}
              >
                {generatingMapping ? 'Generating…' : 'Generate Mapping sheet rows'}
              </button>
              {mappingError && <p className="error">{mappingError}</p>}
            </>
          )}

          {mappingRows && (
            <>
              <div className="resultBlock">
                <div className="resultHeader">
                  <h3>Mapping sheet rows</h3>
                  <button className="small" onClick={() => copyToClipboard(mappingRowsAsTsv(mappingRows), 'rows')}>
                    {copiedKey === 'rows' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="hint">
                  Paste these into cell A1 of the "Mapping" tab, <strong>replacing everything currently there</strong>{' '}
                  (tab-separated — pastes as a real grid). This is now the connector's complete mapping, not an addition
                  to what was there before — see the "DO NOT EDIT" row included at the top.
                </p>
                <table className="mappingTable">
                  <tbody>
                    {mappingRows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="navRow">
                <button className="ghost" onClick={() => setStep(1)}>Back</button>
                {isEditMode ? (
                  <button onClick={() => setStep(5)}>Done — nothing else to change</button>
                ) : (
                  <button onClick={() => setStep(3)}>Next: Register the connector</button>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="step">
          <h2>3. Register the connector</h2>
          <p className="hint">
            Add this connector via the admin page — prefilled with everything from the steps above, no GitHub access needed:
          </p>
          <p className="hint">
            Opens in a new tab — after adding it there, come back to <strong>this</strong> tab and click Next below.
          </p>
          <div className="row">
            <a
              href={`/admin?connectorId=${encodeURIComponent(connectorId)}&notionPageId=${encodeURIComponent(notionPageId || '')}&appsScriptUrl=${encodeURIComponent(appsScriptUrl)}&sheetId=${encodeURIComponent(cleanedSheetId)}`}
              target="_blank"
              rel="noreferrer"
            >
              <button>Open admin page</button>
            </a>
          </div>
          <p className="hint">
            Prefer to edit the file directly? Add this entry to <code>connectors.json</code> in the repo:{' '}
            <a href={CONNECTORS_JSON_URL} target="_blank" rel="noreferrer">
              {CONNECTORS_JSON_URL}
            </a>
          </p>
          <div className="resultBlock">
            <div className="resultHeader">
              <h3>connectors.json entry</h3>
              <button className="small" onClick={() => copyToClipboard(connectorsJsonSnippet, 'connectorsJson')}>
                {copiedKey === 'connectorsJson' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre>{connectorsJsonSnippet}</pre>
          </div>
          {!notionPageId && <p className="error">Couldn't find a page ID in what you pasted in Step 2 — double check it before merging.</p>}
          <div className="navRow">
            <button className="ghost" onClick={() => setStep(2)}>Back</button>
            <button onClick={() => setStep(4)}>Next: Notion button</button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="step">
          <h2>4. Wire up the Notion button</h2>
          <p className="hint">Point this page's button (webhook action) at:</p>
          <div className="resultBlock">
            <div className="resultHeader">
              <h3>Button webhook URL</h3>
              <button className="small" onClick={() => copyToClipboard(buttonUrl, 'buttonUrl')}>
                {copiedKey === 'buttonUrl' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre>{buttonUrl}</pre>
          </div>
          <p className="hint">
            Also confirm the page has a <code>[Status]</code> block (any paragraph or heading starting with{' '}
            <code>[Status]</code>) — that's where sync progress will show up.
          </p>
          <div className="navRow">
            <button className="ghost" onClick={() => setStep(3)}>Back</button>
            <button onClick={() => setStep(5)}>Next: Test it</button>
          </div>
        </section>
      )}

      {step === 5 && (
        <section className="step">
          <h2>5. Test it</h2>
          {isEditMode && (
            <p className="editBanner">
              Mapping updated for <strong>{connectorId}</strong> — no need to redeploy the script or touch{' '}
              <code>connectors.json</code>, since nothing about the connector's identity changed.
            </p>
          )}
          <ol className="instructionsList">
            <li>Click the button on the Notion page.</li>
            <li>Watch the <code>[Status]</code> block — it should move through its stages within a few seconds.</li>
            <li>Confirm charts and table rows actually updated with real data.</li>
            <li>If anything looks off, check the Vercel logs for this connector — chart/table mismatches show up as explicit warnings.</li>
          </ol>
          <div className="navRow">
            <button className="ghost" onClick={() => setStep(isEditMode ? 2 : 4)}>Back</button>
            <button onClick={() => window.location.reload()}>{isEditMode ? 'Done' : 'Start another connector'}</button>
          </div>
        </section>
      )}

      <style jsx global>{`
        .wrap {
          max-width: 1160px;
          margin: 0 auto;
          padding: 40px 24px 80px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #1a1a1a;
        }
        h1 {
          font-size: 28px;
          margin-bottom: 4px;
        }
        .lede {
          color: #555;
          margin-bottom: 8px;
          max-width: 64ch;
        }
        .stepIndicator {
          font-size: 13px;
          font-weight: 600;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 24px;
        }
        .editBanner {
          background: #fff8e6;
          border: 1px solid #f0dca0;
          color: #6b5518;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 13px;
          margin-bottom: 16px;
        }
        .step {
          border-top: 1px solid #e4e4e4;
          padding-top: 24px;
        }
        h2 {
          font-size: 18px;
          margin-bottom: 8px;
        }
        h3 {
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #666;
          margin: 0 0 8px;
        }
        .hint {
          color: #666;
          font-size: 13px;
          margin: 4px 0 12px;
        }
        .row {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 8px;
        }
        input[type='text'] {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 14px;
        }
        button {
          padding: 8px 14px;
          border-radius: 6px;
          border: none;
          background: #1a1a1a;
          color: white;
          font-size: 14px;
          cursor: pointer;
          white-space: nowrap;
        }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        button.small {
          padding: 4px 10px;
          font-size: 12px;
        }
        button.ghost {
          background: transparent;
          color: #666;
          border: 1px solid #ddd;
        }
        .error {
          color: #b3261e;
          font-size: 13px;
          margin-top: 8px;
        }
        .pageLayout {
          border-radius: 12px;
          padding: 20px;
          height: 560px;
          min-height: 300px;
          min-width: 400px;
          overflow: auto;
          margin-bottom: 12px;
          background: #f4f6fb;
          resize: both;
        }
        .columnsRow {
          display: flex;
          gap: 16px;
          align-items: flex-start;
          margin: 12px 0;
        }
        .columnBox {
          flex: 1;
          min-width: 220px;
          border-radius: 10px;
          padding: 14px;
          background: white;
          box-shadow: 0 1px 3px rgba(30, 30, 60, 0.08);
        }
        .pageHeading {
          color: #22264a;
          margin: 16px 0 8px;
        }
        .pageText {
          color: #555;
          font-size: 13px;
          margin: 6px 0;
        }
        .chartBox {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
          border-radius: 10px;
          padding: 14px 16px;
          margin: 10px 0;
          background: #eef3ff;
        }
        .chartIcon {
          font-size: 20px;
          opacity: 0.6;
        }
        .chartBox input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #cdd8f5;
          border-radius: 6px;
          font-size: 13px;
          background: white;
        }
        .pageTable {
          border-collapse: separate;
          border-spacing: 0;
          margin: 10px 0;
          background: white;
          font-size: 13px;
          width: 100%;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(30, 30, 60, 0.06);
        }
        .pageTable th,
        .pageTable td {
          padding: 8px 10px;
          border-bottom: 1px solid #eef0f6;
        }
        .pageTable th {
          background: #eef1fb;
          color: #33396b;
          font-weight: 600;
          text-align: left;
        }
        .pageTable tr:last-child td {
          border-bottom: none;
        }
        .pageTable tbody tr:nth-child(odd) td {
          background: #fbfbfe;
        }
        .pageTable th.tabHeader {
          background: #e3ddfb;
          color: #5b3fd6;
          font-size: 11px;
          text-transform: uppercase;
        }
        .pageTable td.tabCell {
          background: #f6f4ff;
        }
        .pageTable input {
          width: 100%;
          box-sizing: border-box;
          border: none;
          background: transparent;
          padding: 4px 6px;
          font-size: 12px;
        }
        .pageTable input:focus {
          outline: 2px solid #1a1a1a;
          border-radius: 4px;
        }
        .field {
          display: block;
          font-size: 13px;
          color: #333;
          margin-bottom: 14px;
        }
        .field input {
          display: block;
          width: 100%;
          margin-top: 4px;
          padding: 8px 10px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 14px;
        }
        .resultBlock {
          margin: 16px 0;
        }
        .resultHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        pre {
          background: #1a1a1a;
          color: #e4e4e4;
          padding: 16px;
          border-radius: 8px;
          overflow-x: auto;
          font-size: 12px;
          line-height: 1.5;
          max-height: 400px;
        }
        .mappingTable {
          border-collapse: collapse;
          font-size: 12px;
          font-family: monospace;
        }
        .mappingTable td {
          border: 1px solid #ddd;
          padding: 4px 8px;
        }
        .instructionsList {
          font-size: 13px;
          color: #333;
          padding-left: 20px;
          margin: 12px 0;
        }
        .instructionsList li {
          margin-bottom: 6px;
        }
        .navRow {
          display: flex;
          justify-content: space-between;
          margin-top: 16px;
        }
      `}</style>
    </main>
  );
}
