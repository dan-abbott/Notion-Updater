import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client } from '@notionhq/client';

// Initialize the official Notion SDK
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function POST(request: Request) {
  try {
    // 1. Verify the webhook (optional but recommended)
    // const body = await request.json();

    // 2. Ping your Apps Script microservice to get the raw image data
    // (You would trim down your Apps Script to ONLY return the chart blob)
    const scriptResponse = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL!, {
      method: 'GET',
    });
    
    if (!scriptResponse.ok) throw new Error("Failed to fetch chart from Google");
    const imageBuffer = await scriptResponse.blob();

    // 3. Upload to Vercel Blob (Replaces ImgBB completely)
    const timestamp = new Date().getTime();
    const { url: publicImageUrl } = await put(`charts/dashboard-plot-${timestamp}.png`, imageBuffer, {
      access: 'public',
    });

    console.log("Chart hosted on Vercel Blob:", publicImageUrl);

    // 4. Read the Notion Page state
    const pageId = process.env.NOTION_PAGE_ID!;
    const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
    
    // (You would implement your recursive search here to find the anchor text)
    // For brevity, assuming we found the target image block ID:
    const targetBlockId = "YOUR_FOUND_BLOCK_ID"; 

    // 5. Update the Notion Block using the SDK
    await notion.blocks.update({
      block_id: targetBlockId,
      image: {
        external: { url: publicImageUrl }
      }
    });

    // 6. Return a 200 OK so the Notion button shows a success checkmark
    return NextResponse.json({ success: true, message: "Dashboard Synced" });

  } catch (error) {
    console.error(error);
    return NextResponse.json({ success: false, error: "Sync failed" }, { status: 500 });
  }
}
