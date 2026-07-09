import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function POST(request: Request) {
  // 1. Log the initiation
  console.log(`[NOTION SYNC] Triggered at ${new Date().toISOString()}`);

  try {
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

    // 4. Log the Notion update phase
    const pageId = process.env.NOTION_PAGE_ID!;
    console.log(`[NOTION SYNC] Fetching block state for Notion Page ID: ${pageId}...`);
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
    
    // (Assuming your recursive search logic is here)
    const targetBlockId = "YOUR_FOUND_BLOCK_ID"; 
    
    console.log(`[NOTION SYNC] Updating Notion Block ID: ${targetBlockId}...`);
    await notion.blocks.update({
      block_id: targetBlockId,
      image: {
        external: { url: publicImageUrl }
      }
    });

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