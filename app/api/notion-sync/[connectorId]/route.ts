import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { notion } from '@/lib/notion';
import { getConnectorConfig } from '@/lib/connectors';

// Hobby plan's configurable ceiling. The full pipeline (trigger the Apps
// Script's pre-export step, fetch mapped chart/table data, upload each
// chart to Blob, update Notion) can run 15-30+ seconds depending on chart
// count — comfortably under this, but the default Vercel timeout (10s) is
// not enough, so this must stay set explicitly. Raise if upgrading to Pro
// and chart count grows.
export const maxDuration = 60;

const STATUS_PREFIX = '[Status]';

// Finds a heading_3 or paragraph block whose text starts with "[Status]"
// anywhere on the page. This is the ONLY thing still found by text search —
// charts and table rows are addressed directly by block ID via each
// connector's Mapping sheet, with no page-tree searching or text-anchor
// matching involved at all.
async function findStatusBlock(blocks: any[]): Promise<{ id: string; type: 'heading_3' | 'paragraph' } | null> {
  for (const block of blocks) {
    if (block.type === 'heading_3' || block.type === 'paragraph') {
      const text = block[block.type].rich_text
        .map((rt: any) => rt.plain_text)
        .join('')
        .trim();
      if (text.startsWith(STATUS_PREFIX)) {
        return { id: block.id, type: block.type };
      }
    }
    if (block.has_children) {
      const childrenResponse = await notion.blocks.children.list({ block_id: block.id });
      const found = await findStatusBlock(childrenResponse.results);
      if (found) return found;
    }
  }
  return null;
}

// Best-effort status update: writes "[Status] <message>" into whatever
// block currently starts with "[Status]" on the page. Never throws — a
// failure here (e.g. no status block exists yet) should never abort the
// actual sync, since the status text is a nice-to-have, not the point.
async function updateStatus(pageId: string, message: string): Promise<void> {
  try {
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
    const statusBlock = await findStatusBlock(blocksResponse.results);
    if (!statusBlock) {
      console.log(`[NOTION SYNC] No "${STATUS_PREFIX}" block found on the page — skipping status update: ${message}`);
      return;
    }
    await notion.blocks.update({
      block_id: statusBlock.id,
      [statusBlock.type]: {
        rich_text: [{ type: 'text', text: { content: `${STATUS_PREFIX} ${message}` } }],
      },
    } as any);
  } catch (err) {
    console.error('[NOTION SYNC] Failed to update status block (non-fatal):', err);
  }
}

// Triggers the Apps Script's optional pre-export step via
// ?action=runPreExport, and waits for it to finish before this function
// returns. Every connector's Notion.gs defines this action — it's a no-op
// (immediate success) if that connector's script wasn't generated with a
// pre-export function configured, so the middleware can call it
// unconditionally for every connector without needing to know whether one
// is actually configured.
async function triggerPreExport(appsScriptUrl: string): Promise<void> {
  const url = new URL(appsScriptUrl);
  url.searchParams.set('action', 'runPreExport');

  console.log(`[NOTION SYNC] Triggering Apps Script pre-export step...`);
  const scriptResponse = await fetch(url.toString(), { method: 'GET' });
  const responseText = await scriptResponse.text();

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Google Apps Script did not return valid JSON for runPreExport. First 200 chars: ${responseText.slice(0, 200)}`
    );
  }

  if (!data.success) {
    throw new Error(
      `Apps Script pre-export step failed${data.phase ? ` during the "${data.phase}" phase` : ''}: ${data.error || 'unknown error'}`
    );
  }
  console.log(`[NOTION SYNC] Pre-export step completed successfully.`);
}

type MappedChart = {
  blockId: string;
  imageBase64: string;
};

type MappedTableRow = {
  blockId: string;
  values: string[];
};

// Fetches everything this connector's Apps Script "Mapping" sheet points
// at, already resolved: chart images ready to upload, and table row values
// ready to write. No anchor text, no title matching — every item already
// carries the exact Notion block ID it belongs to.
async function fetchMappedDataFromScript(
  appsScriptUrl: string
): Promise<{ tableRows: MappedTableRow[]; charts: MappedChart[] }> {
  console.log(`[NOTION SYNC] Fetching mapped chart/table data from Google Apps Script...`);
  const scriptResponse = await fetch(appsScriptUrl, { method: 'GET' });
  const responseText = await scriptResponse.text();

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Google Apps Script did not return valid JSON. This usually means the Web App deployment ` +
      `requires a Google sign-in (check "Who has access" in Deploy > Manage deployments) rather ` +
      `than running the script directly. First 200 chars of response: ${responseText.slice(0, 200)}`
    );
  }
  if (!Array.isArray(data?.tableRows) || !Array.isArray(data?.charts)) {
    throw new Error(`Google Apps Script response missing "tableRows"/"charts" arrays. Received: ${JSON.stringify(data).slice(0, 300)}`);
  }
  if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
    console.log(`[NOTION SYNC] ⚠️ Apps Script reported ${data.warnings.length} warning(s):`);
    data.warnings.forEach((w: string) => console.log(`[NOTION SYNC]   - ${w}`));
  }
  console.log(`[NOTION SYNC] Script returned ${data.charts.length} chart(s) and ${data.tableRows.length} table row(s).`);
  return data;
}

// Uploads one chart's base64 PNG to Vercel Blob, then updates the Notion
// image block directly by its known block ID. Always an update — since the
// block ID came from an existing block in Notion, there's no "insert if
// missing" branch to handle.
async function syncOneMappedChart(chart: MappedChart): Promise<void> {
  const imageBuffer = Buffer.from(chart.imageBase64, 'base64');
  console.log(`[NOTION SYNC] [chart ${chart.blockId}] Decoded image buffer (${imageBuffer.length} bytes).`);

  const timestamp = new Date().getTime();
  console.log(`[NOTION SYNC] [chart ${chart.blockId}] Uploading to Vercel Blob...`);
  const { url: publicImageUrl } = await put(`charts/${chart.blockId}-${timestamp}.png`, imageBuffer, {
    access: 'public',
    contentType: 'image/png',
  });
  console.log(`[NOTION SYNC] [chart ${chart.blockId}] Blob upload complete. URL: ${publicImageUrl}`);

  await notion.blocks.update({
    block_id: chart.blockId,
    image: {
      external: { url: publicImageUrl },
    },
  });
}

// Overwrites one Notion table_row block's cells with fresh values, by its
// known block ID. Column count must match the row's existing width —
// Notion's API enforces this itself and throws a validation error if not.
async function syncOneMappedTableRow(row: MappedTableRow): Promise<void> {
  await notion.blocks.update({
    block_id: row.blockId,
    table_row: {
      cells: row.values.map(v => [{ type: 'text' as const, text: { content: v } }]),
    },
  } as any);
  console.log(`[NOTION SYNC] [row ${row.blockId}] Updated with ${row.values.length} value(s).`);
}

export async function POST(request: Request, { params }: { params: { connectorId: string } }) {
  const { connectorId } = params;
  console.log(`[NOTION SYNC] Triggered for connector "${connectorId}" at ${new Date().toISOString()}`);

  let pageId: string;
  let appsScriptUrl: string;
  try {
    const config = getConnectorConfig(connectorId);
    pageId = config.notionPageId;
    appsScriptUrl = config.appsScriptUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[NOTION SYNC] ❌ Connector lookup failed:`, message);
    return NextResponse.json({ success: false, error: message }, { status: 404 });
  }

  // IMPORTANT: Notion's button-triggered webhook has its own (short)
  // response-wait timeout that is shorter than this pipeline's total
  // runtime. If we don't respond until the whole pipeline finishes, Notion
  // reports "webhook request timed out" even though the pipeline itself
  // completes successfully moments later. The fix: post the first status
  // update synchronously (fast, so it's visibly there almost immediately),
  // acknowledge Notion's webhook right away, then keep running the actual
  // pipeline in the background via waitUntil() — which extends this
  // function's lifetime past the response up to maxDuration, independent
  // of whether Notion is still listening. All progress after this point is
  // only visible through the [Status] block, not through Notion's own
  // button UI.
  await updateStatus(pageId, 'Pulling in the data...');

  waitUntil(runSyncPipeline(pageId, appsScriptUrl));

  return NextResponse.json({ success: true, message: 'Sync started' });
}

// The actual pipeline, run in the background after POST has already
// responded to Notion (see waitUntil() above). Every failure path here
// still needs to update the [Status] block itself, since there is no
// HTTP response left to report failure through by the time this runs.
async function runSyncPipeline(pageId: string, appsScriptUrl: string): Promise<void> {
  try {
    try {
      await triggerPreExport(appsScriptUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await updateStatus(pageId, `Pre-export step failed: ${message}`);
      console.error(`[NOTION SYNC] ❌ Sync failed! Reason:`, error);
      return;
    }

    await updateStatus(pageId, 'Updating charts and tables...');

    const { tableRows, charts } = await fetchMappedDataFromScript(appsScriptUrl);

    const chartResults = await Promise.allSettled(charts.map(c => syncOneMappedChart(c)));
    const rowResults = await Promise.allSettled(tableRows.map(r => syncOneMappedTableRow(r)));

    const chartFailed = chartResults
      .map((r, i) => ({ r, blockId: charts[i].blockId }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, blockId }) => ({
        blockId,
        error: r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '',
      }));
    const rowFailed = rowResults
      .map((r, i) => ({ r, blockId: tableRows[i].blockId }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, blockId }) => ({
        blockId,
        error: r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '',
      }));

    if (chartFailed.length > 0) {
      console.error(`[NOTION SYNC] ⚠️ ${chartFailed.length}/${charts.length} chart(s) failed:`, chartFailed);
    }
    if (rowFailed.length > 0) {
      console.error(`[NOTION SYNC] ⚠️ ${rowFailed.length}/${tableRows.length} table row(s) failed:`, rowFailed);
    }
    console.log(
      `[NOTION SYNC] ✅ Sync run complete. ${charts.length - chartFailed.length}/${charts.length} chart(s), ` +
      `${tableRows.length - rowFailed.length}/${tableRows.length} table row(s) synced.`
    );

    const totalFailed = chartFailed.length + rowFailed.length;
    const chartsSynced = charts.length - chartFailed.length;
    const rowsSynced = tableRows.length - rowFailed.length;

    if (totalFailed === 0) {
      await updateStatus(
        pageId,
        `New charts populated! (${chartsSynced} chart${chartsSynced === 1 ? '' : 's'}, ${rowsSynced} row${rowsSynced === 1 ? '' : 's'})`
      );
    } else {
      await updateStatus(pageId, `Completed with ${totalFailed} failure(s) — check logs`);
    }
  } catch (error) {
    console.error(`[NOTION SYNC] ❌ Sync failed! Reason:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    // Best-effort — updateStatus() never throws, so this is safe even if
    // the failure happened before any prior status update succeeded.
    await updateStatus(pageId, `Sync failed: ${message}`);
  }
}
