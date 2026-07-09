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

// Fetches the chart image for a single anchor from the Google Apps Script,
// uploads it to Vercel Blob, then updates or inserts the corresponding
// Notion image block. Throws on failure — caller decides whether one
// chart's failure should stop the whole run.
async function syncOneChart(anchor: AnchorMatch): Promise<void> {
  const { chartTitle, anchorId, parentId, targetId } = anchor;

  console.log(`[NOTION SYNC] [${chartTitle}] Fetching chart from Google Apps Script...`);
  const scriptUrl = new URL(process.env.GOOGLE_APPS_SCRIPT_URL!);
  scriptUrl.searchParams.set('chart', chartTitle);

  const scriptResponse = await fetch(scriptUrl.toString(), { method: 'GET' });
  if (!scriptResponse.ok) {
    throw new Error(`Google Apps Script responded with status: ${scriptResponse.status}`);
  }
  const imageBuffer = await scriptResponse.blob();
  console.log(`[NOTION SYNC] [${chartTitle}] Retrieved image blob (${imageBuffer.size} bytes).`);

  const timestamp = new Date().getTime();
  const slug = chartTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  console.log(`[NOTION SYNC] [${chartTitle}] Uploading to Vercel Blob...`);
  const { url: publicImageUrl } = await put(`charts/${slug}-${timestamp}.png`, imageBuffer, {
    access: 'public',
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
    const pageId = process.env.NOTION_PAGE_ID!;
    console.log(`[NOTION SYNC] Fetching block state for Notion Page ID: ${pageId}...`);
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });

    const anchors = await findAllChartAnchors(blocksResponse.results, pageId);
    console.log(`[NOTION SYNC] Found ${anchors.length} chart anchor(s): ${anchors.map(a => a.chartTitle).join(', ') || '(none)'}`);

    if (anchors.length === 0) {
      throw new Error(
        `No blocks found starting with "${ANCHOR_PREFIX}". Add at least one heading_3 or paragraph ` +
        `block like "${ANCHOR_PREFIX}My Chart Title" to the Notion page before syncing.`
      );
    }

    // Sync each chart independently — one failure shouldn't block the rest.
    const results = await Promise.allSettled(anchors.map(syncOneChart));

    const succeeded = results
      .map((r, i) => ({ r, title: anchors[i].chartTitle }))
      .filter(({ r }) => r.status === 'fulfilled')
      .map(({ title }) => title);
    const failed = results
      .map((r, i) => ({ r, title: anchors[i].chartTitle }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, title }) => ({
        chartTitle: title,
        error: r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '',
      }));

    if (failed.length > 0) {
      console.error(`[NOTION SYNC] ⚠️ ${failed.length}/${anchors.length} chart(s) failed:`, failed);
    }
    console.log(`[NOTION SYNC] ✅ Sync run complete. ${succeeded.length}/${anchors.length} chart(s) synced.`);

    return NextResponse.json({
      success: failed.length === 0,
      synced: succeeded,
      failed,
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