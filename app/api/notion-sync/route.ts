import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const ANCHOR_PREFIX = '[Chart] ';

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

  const data = await scriptResponse.json();
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

  try {
    const pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) {
      throw new Error('NOTION_PAGE_ID environment variable is not set.');
    }

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
      throw new Error(
        `No chart titles matched between the Notion page anchors (${anchors.map(a => a.chartTitle).join(', ') || 'none'}) ` +
        `and the charts returned by the script (${charts.map(c => c.title).join(', ') || 'none'}). ` +
        `Chart titles in Google Sheets must exactly match the text after "${ANCHOR_PREFIX}" in Notion.`
      );
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
    
    // You can also return the error message in the response for debugging 
    // directly inside the Notion webhook response body (Make sure not to leak secrets!)
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error occurred" 
    }, { status: 500 });
  }
}