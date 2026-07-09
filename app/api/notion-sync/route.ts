import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

type AnchorMatch = {
  anchorId: string;
  parentId: string;
  targetId?: string;
};

// Recursively walks a block tree looking for a heading_3 or paragraph block
// whose text exactly matches `expectedAnchorText`. If found, also checks
// whether the immediately-following sibling is already an image block.
//
// NOTE: This does a live API call (`notion.blocks.children.list`) for every
// block flagged `has_children`, so a deeply nested page will cost multiple
// Notion API requests per sync. Keep the anchor block near the top level
// where possible to minimize latency.
async function findAnchorAndTarget(
  blocks: any[],
  parentId: string,
  expectedAnchorText: string
): Promise<AnchorMatch | null> {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block.type === 'heading_3' || block.type === 'paragraph') {
      const text = block[block.type].rich_text
        .map((rt: any) => rt.plain_text)
        .join('')
        .trim();

      if (text === expectedAnchorText) {
        const nextBlock = blocks[i + 1];
        return {
          anchorId: block.id,
          parentId,
          targetId: nextBlock?.type === 'image' ? nextBlock.id : undefined,
        };
      }
    }

    if (block.has_children) {
      const childrenResponse = await notion.blocks.children.list({ block_id: block.id });
      const match = await findAnchorAndTarget(childrenResponse.results, block.id, expectedAnchorText);
      if (match) return match;
    }
  }
  return null;
}

export async function POST(request: Request) {
  // 1. Log the initiation
  console.log(`[NOTION SYNC] Triggered at ${new Date().toISOString()}`);

  try {
    // 1a. Parse the incoming payload from the Notion button push
    const body = await request.json().catch(() => ({}));
    const chartTitle = body?.chartTitle;

    if (!chartTitle || typeof chartTitle !== 'string') {
      throw new Error('Request body must include a "chartTitle" string field.');
    }
    const expectedAnchorText = `[Chart] ${chartTitle}`;

    // 2. Log the external fetch
    console.log(`[NOTION SYNC] Fetching raw chart from Google Apps Script...`);
    const scriptResponse = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL!, {
      method: 'GET',
    });
    
    if (!scriptResponse.ok) {
      throw new Error(`Google Apps Script responded with status: ${scriptResponse.status}`);
    }
    const imageBuffer = await scriptResponse.blob();
    console.log(`[NOTION SYNC] Successfully retrieved image blob (${imageBuffer.size} bytes).`);

    // 3. Log the Blob upload
    const timestamp = new Date().getTime();
    console.log(`[NOTION SYNC] Uploading to Vercel Blob...`);
    const { url: publicImageUrl } = await put(`charts/dashboard-plot-${timestamp}.png`, imageBuffer, {
      access: 'public',
    });
    console.log(`[NOTION SYNC] Blob upload complete. URL: ${publicImageUrl}`);

    // 4. Locate the anchor block (and possibly an existing image block after it)
    const pageId = process.env.NOTION_PAGE_ID!;
    console.log(`[NOTION SYNC] Fetching block state for Notion Page ID: ${pageId}...`);
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });

    const match = await findAnchorAndTarget(blocksResponse.results, pageId, expectedAnchorText);

    if (!match) {
      throw new Error(
        `No block found with anchor text "${expectedAnchorText}". Add a heading_3 or paragraph ` +
        `block with this exact text to the Notion page before syncing.`
      );
    }

    if (match.targetId) {
      // An image block already exists right after the anchor — update it in place
      console.log(`[NOTION SYNC] Updating existing image Block ID: ${match.targetId}...`);
      await notion.blocks.update({
        block_id: match.targetId,
        image: {
          external: { url: publicImageUrl },
        },
      });
    } else {
      // No image block yet — insert a new one directly after the anchor
      console.log(`[NOTION SYNC] No existing image block found; appending new image after anchor ${match.anchorId}...`);
      await notion.blocks.children.append({
        block_id: match.parentId,
        after: match.anchorId,
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

    console.log(`[NOTION SYNC] ✅ Sync completed successfully.`);
    return NextResponse.json({ success: true, message: "Dashboard Synced" });

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