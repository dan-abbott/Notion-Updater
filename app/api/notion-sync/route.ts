import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client } from '@notionhq/client';

// Hobby plan's configurable ceiling. The full pipeline (trigger the Apps
// Script's import+analysis, fetch charts, upload each to Blob, update
// Notion) can run 15-30+ seconds depending on chart count — comfortably
// under this, but the default Vercel timeout (10s) is not enough, so this
// must stay set explicitly. Raise if upgrading to Pro and chart count grows.
export const maxDuration = 60;

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const ANCHOR_PREFIX = '[Chart] ';
const STATUS_PREFIX = '[Status]';

type AnchorMatch = {
  chartTitle: string;
  anchorId: string;
  parentId: string;
  targetId?: string;
};

// Recursively walks the entire block tree under a page and collects every
// heading_3 / paragraph block whose text starts with "[Chart] ". For each
// match, also checks whether the immediately-following sibling is already
// an image block (the thing to overwrite) or not (the thing to insert after).
//
// NOTE: This does a live API call (`notion.blocks.children.list`) for every
// block flagged `has_children`, so a deeply nested page costs one Notion API
// request per nested container, on every sync run. Keep chart anchors as
// shallow as possible.
async function findAllChartAnchors(blocks: any[], parentId: string): Promise<AnchorMatch[]> {
  const matches: AnchorMatch[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block.type === 'heading_3' || block.type === 'paragraph') {
      const text = block[block.type].rich_text
        .map((rt: any) => rt.plain_text)
        .join('')
        .trim();

      if (text.startsWith(ANCHOR_PREFIX)) {
        const chartTitle = text.slice(ANCHOR_PREFIX.length).trim();
        const nextBlock = blocks[i + 1];
        matches.push({
          chartTitle,
          anchorId: block.id,
          parentId,
          targetId: nextBlock?.type === 'image' ? nextBlock.id : undefined,
        });
      }
    }

    if (block.has_children) {
      const childrenResponse = await notion.blocks.children.list({ block_id: block.id });
      const nested = await findAllChartAnchors(childrenResponse.results, block.id);
      matches.push(...nested);
    }
  }

  return matches;
}

// Finds a heading_3 or paragraph block whose text starts with "[Status]"
// anywhere on the page (same recursive-search pattern as chart anchors).
// Returns both the block id and its actual type, since Notion's update API
// requires the property key to match the block's own type (heading_3 vs
// paragraph) — passing the wrong one is rejected.
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

// Triggers the Apps Script's headless import+analysis pipeline
// (UpdatePortfolio + processPortfolioData) via ?action=generateMetrics,
// and waits for it to finish before this function returns. Distinct from
// fetchChartsFromScript() below, which calls the same URL with no action
// param to get chart data instead.
async function triggerGenerateMetrics(): Promise<void> {
  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  if (!scriptUrl) {
    throw new Error('GOOGLE_APPS_SCRIPT_URL environment variable is not set.');
  }

  const url = new URL(scriptUrl);
  url.searchParams.set('action', 'generateMetrics');

  console.log(`[NOTION SYNC] Triggering Apps Script generateMetrics (import + analysis)...`);
  const scriptResponse = await fetch(url.toString(), { method: 'GET' });
  const responseText = await scriptResponse.text();

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Google Apps Script did not return valid JSON for generateMetrics. First 200 chars: ${responseText.slice(0, 200)}`
    );
  }

  if (!data.success) {
    throw new Error(
      `Apps Script generateMetrics failed during the "${data.phase || 'unknown'}" phase: ${data.error || 'unknown error'}`
    );
  }
  console.log(`[NOTION SYNC] generateMetrics completed successfully.`);
}

type ScriptChart = {
  title: string;
  imageBase64: string;
};

// Fetches ALL charts in one call. The Apps Script's doGet no longer talks to
// Notion or ImgBB at all — it just exports every chart on the sheet as a
// base64-encoded PNG and returns them as JSON: { charts: [{ title, imageBase64 }] }.
// Vercel Blob (via `put` below) is now the only image host in this system.
async function fetchChartsFromScript(): Promise<ScriptChart[]> {
  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  if (!scriptUrl) {
    throw new Error('GOOGLE_APPS_SCRIPT_URL environment variable is not set.');
  }

  console.log(`[NOTION SYNC] Fetching all charts from Google Apps Script...`);
  const scriptResponse = await fetch(scriptUrl, { method: 'GET' });
  if (!scriptResponse.ok) {
    const text = await scriptResponse.text().catch(() => '');
    throw new Error(`Google Apps Script responded with status ${scriptResponse.status}: ${text}`);
  }

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
  if (!Array.isArray(data?.charts)) {
    throw new Error(`Google Apps Script response did not contain a "charts" array. Received: ${JSON.stringify(data).slice(0, 300)}`);
  }
  console.log(`[NOTION SYNC] Script returned ${data.charts.length} chart(s): ${data.charts.map((c: ScriptChart) => c.title).join(', ')}`);
  return data.charts;
}

// Uploads one chart's base64 PNG to Vercel Blob, then updates or inserts the
// corresponding Notion image block. Throws on failure — caller decides
// whether one chart's failure should stop the whole run.
async function syncOneChart(anchor: AnchorMatch, chart: ScriptChart): Promise<void> {
  const { chartTitle, anchorId, parentId, targetId } = anchor;

  const imageBuffer = Buffer.from(chart.imageBase64, 'base64');
  console.log(`[NOTION SYNC] [${chartTitle}] Decoded image buffer (${imageBuffer.length} bytes).`);

  const timestamp = new Date().getTime();
  const slug = chartTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  console.log(`[NOTION SYNC] [${chartTitle}] Uploading to Vercel Blob...`);
  const { url: publicImageUrl } = await put(`charts/${slug}-${timestamp}.png`, imageBuffer, {
    access: 'public',
    contentType: 'image/png',
  });
  console.log(`[NOTION SYNC] [${chartTitle}] Blob upload complete. URL: ${publicImageUrl}`);

  if (targetId) {
    console.log(`[NOTION SYNC] [${chartTitle}] Updating existing image Block ID: ${targetId}...`);
    await notion.blocks.update({
      block_id: targetId,
      image: {
        external: { url: publicImageUrl },
      },
    });
  } else {
    console.log(`[NOTION SYNC] [${chartTitle}] No existing image block found; appending new image after anchor ${anchorId}...`);
    await notion.blocks.children.append({
      block_id: parentId,
      after: anchorId,
      children: [
        {
          object: 'block',
          type: 'image',
          image: {
            type: 'external',
            external: { url: publicImageUrl },
          },
        },
      ],
    });
  }
}

export async function POST(request: Request) {
  // 1. Log the initiation. The Notion button sends no useful payload —
  // this is a bare trigger — so every chart on the page is discovered
  // and synced in a single run.
  console.log(`[NOTION SYNC] Triggered at ${new Date().toISOString()}`);

  // Hoisted so the outer catch block can also post a status update on
  // failure, even if the failure happens after pageId is set.
  let pageId: string | undefined;

  try {
    pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) {
      throw new Error('NOTION_PAGE_ID environment variable is not set.');
    }

    await updateStatus(pageId, 'Pulling in the data...');

    try {
      await triggerGenerateMetrics();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await updateStatus(pageId, `Data import/analysis failed: ${message}`);
      throw error;
    }

    await updateStatus(pageId, 'Updating charts...');

    console.log(`[NOTION SYNC] Fetching block state for Notion Page ID: ${pageId}...`);
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
    const anchors = await findAllChartAnchors(blocksResponse.results, pageId);
    console.log(`[NOTION SYNC] Found ${anchors.length} chart anchor(s) in Notion: ${anchors.map(a => a.chartTitle).join(', ') || '(none)'}`);

    const charts = await fetchChartsFromScript();

    // Match each anchor to a chart returned by the script, by exact title.
    // Anchors with no matching chart, and charts with no matching anchor,
    // are logged and skipped rather than treated as fatal errors — a
    // one-sided mismatch on a given run shouldn't block the charts that
    // do line up.
    const pairs: { anchor: AnchorMatch; chart: ScriptChart }[] = [];
    const unmatchedAnchors: string[] = [];
    for (const anchor of anchors) {
      const chart = charts.find(c => c.title === anchor.chartTitle);
      if (chart) {
        pairs.push({ anchor, chart });
      } else {
        unmatchedAnchors.push(anchor.chartTitle);
      }
    }
    const unmatchedCharts = charts
      .filter(c => !anchors.some(a => a.chartTitle === c.title))
      .map(c => c.title);

    if (unmatchedAnchors.length > 0) {
      console.log(`[NOTION SYNC] ⚠️ Notion anchor(s) with no matching chart from the script: ${unmatchedAnchors.join(', ')}`);
    }
    if (unmatchedCharts.length > 0) {
      console.log(`[NOTION SYNC] ⚠️ Chart(s) from the script with no matching Notion anchor: ${unmatchedCharts.join(', ')}`);
    }

    if (pairs.length === 0) {
      const message =
        `No chart titles matched between the Notion page anchors (${anchors.map(a => a.chartTitle).join(', ') || 'none'}) ` +
        `and the charts returned by the script (${charts.map(c => c.title).join(', ') || 'none'}). ` +
        `Chart titles in Google Sheets must exactly match the text after "${ANCHOR_PREFIX}" in Notion.`;
      await updateStatus(pageId, `No charts matched — check titles`);
      throw new Error(message);
    }

    // Sync each matched chart independently — one failure shouldn't block the rest.
    const results = await Promise.allSettled(pairs.map(({ anchor, chart }) => syncOneChart(anchor, chart)));

    const succeeded = results
      .map((r, i) => ({ r, title: pairs[i].anchor.chartTitle }))
      .filter(({ r }) => r.status === 'fulfilled')
      .map(({ title }) => title);
    const failed = results
      .map((r, i) => ({ r, title: pairs[i].anchor.chartTitle }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, title }) => ({
        chartTitle: title,
        error: r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '',
      }));

    if (failed.length > 0) {
      console.error(`[NOTION SYNC] ⚠️ ${failed.length}/${pairs.length} chart(s) failed:`, failed);
    }
    console.log(`[NOTION SYNC] ✅ Sync run complete. ${succeeded.length}/${pairs.length} chart(s) synced.`);

    if (failed.length === 0) {
      await updateStatus(pageId, `New charts populated! (${succeeded.length} chart${succeeded.length === 1 ? '' : 's'})`);
    } else {
      await updateStatus(pageId, `Completed with ${failed.length}/${pairs.length} chart failure(s) — check logs`);
    }

    return NextResponse.json({
      success: failed.length === 0,
      synced: succeeded,
      failed,
      unmatchedAnchors,
      unmatchedCharts,
    }, { status: failed.length > 0 && succeeded.length === 0 ? 500 : 200 });

  } catch (error) {
    // 5. Explicitly log errors to the stderr stream
    console.error(`[NOTION SYNC] ❌ Sync failed! Reason:`, error);

    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    if (pageId) {
      // Best-effort — updateStatus() never throws, so this is safe even if
      // the failure happened before any prior status update succeeded.
      await updateStatus(pageId, `Sync failed: ${message}`);
    }

    // You can also return the error message in the response for debugging 
    // directly inside the Notion webhook response body (Make sure not to leak secrets!)
    return NextResponse.json({ 
      success: false, 
      error: message
    }, { status: 500 });
  }
}