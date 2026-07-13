'use client';

import { useState } from 'react';

type BlockRow = {
  id: string;
  type: string;
  depth: number;
  preview: string;
};

type ChartMapping = {
  blockId: string;
  chartTitle: string;
};

type TableRowMapping = {
  blockId: string;
  sourceCells: string; // comma-separated in the UI, split before sending
};

export default function SetupPage() {
  const [pageInput, setPageInput] = useState('');
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null);
  const [loadingBlocks, setLoadingBlocks] = useState(false);
  const [blocksError, setBlocksError] = useState<string | null>(null);

  const [chartMappings, setChartMappings] = useState<ChartMapping[]>([]);
  const [tableRowMappings, setTableRowMappings] = useState<TableRowMapping[]>([]);

  const [dataSourceTab, setDataSourceTab] = useState('');
  const [preExportFunctionName, setPreExportFunctionName] = useState('');
  const [connectorId, setConnectorId] = useState('');

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [result, setResult] = useState<{ notionGsCode: string; mappingRows: string[][]; instructions: string } | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function handleListBlocks() {
    setLoadingBlocks(true);
    setBlocksError(null);
    setBlocks(null);
    try {
      const res = await fetch('/api/setup/list-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: pageInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not list blocks for that page.');
      setBlocks(data.blocks);
    } catch (err) {
      setBlocksError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingBlocks(false);
    }
  }

  function addChartMapping(blockId: string) {
    setChartMappings(prev => [...prev, { blockId, chartTitle: '' }]);
  }

  function addTableRowMapping(blockId: string) {
    setTableRowMappings(prev => [...prev, { blockId, sourceCells: '' }]);
  }

  function updateChartTitle(index: number, title: string) {
    setChartMappings(prev => prev.map((m, i) => (i === index ? { ...m, chartTitle: title } : m)));
  }

  function updateSourceCells(index: number, cells: string) {
    setTableRowMappings(prev => prev.map((m, i) => (i === index ? { ...m, sourceCells: cells } : m)));
  }

  function removeChartMapping(index: number) {
    setChartMappings(prev => prev.filter((_, i) => i !== index));
  }

  function removeTableRowMapping(index: number) {
    setTableRowMappings(prev => prev.filter((_, i) => i !== index));
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError(null);
    setResult(null);
    try {
      const res = await fetch('/api/setup/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceTab,
          preExportFunctionName: preExportFunctionName || undefined,
          connectorId: connectorId || undefined,
          charts: chartMappings
            .filter(m => m.chartTitle.trim())
            .map(m => ({ blockId: m.blockId, chartTitle: m.chartTitle.trim() })),
          tableRows: tableRowMappings
            .filter(m => m.sourceCells.trim())
            .map(m => ({
              blockId: m.blockId,
              sourceCells: m.sourceCells.split(',').map(s => s.trim()).filter(Boolean),
            })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate connector files.');
      setResult(data);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setGenerating(false);
    }
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1500);
    });
  }

  function mappingRowsAsTsv(rows: string[][]): string {
    return rows.map(row => row.join('\t')).join('\n');
  }

  return (
    <main className="wrap">
      <h1>Set up a new connector</h1>
      <p className="lede">
        Connect a Notion page to a Google Sheet: paste a Notion page, pick which blocks should get chart images
        or table data, and this generates the two files you need to paste into place.
      </p>

      <section className="step">
        <h2>1. Paste the Notion page</h2>
        <p className="hint">A page URL or page ID.</p>
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
      </section>

      {blocks && (
        <section className="step">
          <h2>2. Choose what gets synced</h2>
          <p className="hint">
            For image blocks, click <strong>Add as chart</strong> and type the exact chart title from Google Sheets.
            For table row blocks, click <strong>Add as table row</strong> and list the source cells in order
            (e.g. <code>C5, D5, E5, F5</code>).
          </p>
          <div className="blockList">
            {blocks.map(block => (
              <div key={block.id} className="blockRow" style={{ paddingLeft: `${block.depth * 20}px` }}>
                <span className="blockType">{block.type}</span>
                <span className="blockPreview">{block.preview}</span>
                <code className="blockId">{block.id}</code>
                {block.type === 'image' && (
                  <button className="small" onClick={() => addChartMapping(block.id)}>
                    Add as chart
                  </button>
                )}
                {block.type === 'table_row' && (
                  <button className="small" onClick={() => addTableRowMapping(block.id)}>
                    Add as table row
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {(chartMappings.length > 0 || tableRowMappings.length > 0) && (
        <section className="step">
          <h2>3. Fill in the details</h2>

          {chartMappings.length > 0 && (
            <>
              <h3>Charts</h3>
              {chartMappings.map((m, i) => (
                <div className="row" key={m.blockId + i}>
                  <code className="blockId">{m.blockId}</code>
                  <input
                    type="text"
                    placeholder="Exact chart title in Google Sheets"
                    value={m.chartTitle}
                    onChange={e => updateChartTitle(i, e.target.value)}
                  />
                  <button className="small ghost" onClick={() => removeChartMapping(i)}>
                    Remove
                  </button>
                </div>
              ))}
            </>
          )}

          {tableRowMappings.length > 0 && (
            <>
              <h3>Table rows</h3>
              {tableRowMappings.map((m, i) => (
                <div className="row" key={m.blockId + i}>
                  <code className="blockId">{m.blockId}</code>
                  <input
                    type="text"
                    placeholder="Source cells, e.g. C5, D5, E5, F5"
                    value={m.sourceCells}
                    onChange={e => updateSourceCells(i, e.target.value)}
                  />
                  <button className="small ghost" onClick={() => removeTableRowMapping(i)}>
                    Remove
                  </button>
                </div>
              ))}
            </>
          )}

          <h3>Connector settings</h3>
          <label className="field">
            Data source tab name
            <input
              type="text"
              placeholder="e.g. Testing"
              value={dataSourceTab}
              onChange={e => setDataSourceTab(e.target.value)}
            />
          </label>
          <label className="field">
            Pre-export function name (optional)
            <input
              type="text"
              placeholder="e.g. generateMetricsRemote — leave blank if none"
              value={preExportFunctionName}
              onChange={e => setPreExportFunctionName(e.target.value)}
            />
            <span className="hint">Must already exist in this Sheet's Apps Script project — this only generates the call to it.</span>
          </label>
          <label className="field">
            Connector ID (optional, for instructions)
            <input
              type="text"
              placeholder="e.g. team-b"
              value={connectorId}
              onChange={e => setConnectorId(e.target.value)}
            />
          </label>

          <button onClick={handleGenerate} disabled={generating || !dataSourceTab.trim()}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
          {generateError && <p className="error">{generateError}</p>}
        </section>
      )}

      {result && (
        <section className="step">
          <h2>4. Paste these into place</h2>

          <div className="resultBlock">
            <div className="resultHeader">
              <h3>Notion.gs</h3>
              <button className="small" onClick={() => copyToClipboard(result.notionGsCode, 'code')}>
                {copiedKey === 'code' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="hint">Paste into the Apps Script editor, then deploy as a Web App.</p>
            <pre>{result.notionGsCode}</pre>
          </div>

          <div className="resultBlock">
            <div className="resultHeader">
              <h3>Mapping sheet rows</h3>
              <button className="small" onClick={() => copyToClipboard(mappingRowsAsTsv(result.mappingRows), 'rows')}>
                {copiedKey === 'rows' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="hint">Paste directly into cell A1 of the "Mapping" tab (tab-separated — pastes as a real grid).</p>
            <table className="mappingTable">
              <tbody>
                {result.mappingRows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="resultBlock">
            <div className="resultHeader">
              <h3>Next steps</h3>
              <button className="small" onClick={() => copyToClipboard(result.instructions, 'instructions')}>
                {copiedKey === 'instructions' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="instructions">{result.instructions}</pre>
          </div>
        </section>
      )}

      <style jsx>{`
        .wrap {
          max-width: 860px;
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
          margin-bottom: 32px;
          max-width: 60ch;
        }
        .step {
          border-top: 1px solid #e4e4e4;
          padding-top: 24px;
          margin-top: 24px;
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
          margin: 20px 0 8px;
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
          color: #999;
          border: 1px solid #ddd;
        }
        .error {
          color: #b3261e;
          font-size: 13px;
          margin-top: 8px;
        }
        .blockList {
          border: 1px solid #e4e4e4;
          border-radius: 8px;
          max-height: 420px;
          overflow-y: auto;
        }
        .blockRow {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 12px;
          border-bottom: 1px solid #f0f0f0;
          font-size: 13px;
        }
        .blockType {
          color: #888;
          min-width: 90px;
          font-family: monospace;
        }
        .blockPreview {
          flex: 1;
          color: #333;
        }
        .blockId {
          font-family: monospace;
          font-size: 11px;
          color: #999;
          background: #f6f6f6;
          padding: 2px 6px;
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
          margin-bottom: 28px;
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
        pre.instructions {
          background: #f6f6f6;
          color: #1a1a1a;
          white-space: pre-wrap;
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
      `}</style>
    </main>
  );
}
