import { NextResponse } from 'next/server';
import { notion } from '@/lib/notion';
import { extractNotionId } from '@/lib/notionId';

export const maxDuration = 60;

type BlockRow = {
  id: string;
  type: string;
  depth: number;
  preview: string;
};

function previewForBlock(block: any): string {
  const type = block.type;

  if (type === 'paragraph' || type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
    const text = block[type]?.rich_text?.map((rt: any) => rt.plain_text).join('') ?? '';
    return text.trim() || '(empty)';
  }

  if (type === 'image') {
    const url = block.image?.type === 'external' ? block.image.external?.url : block.image?.file?.url;
    return url ? `Image (currently: ${url.slice(0, 60)}${url.length > 60 ? '...' : ''})` : 'Image (empty)';
  }

  if (type === 'table') {
    const width = block.table?.table_width;
    const hasHeader = block.table?.has_column_header;
    return `Table (${width} column${width === 1 ? '' : 's'}${hasHeader ? ', has header row' : ''})`;
  }

  if (type === 'table_row') {
    const cells: any[][] = block.table_row?.cells ?? [];
    const cellText = cells.map(cell => cell.map((rt: any) => rt.plain_text).join('').trim() || '(blank)');
    return cellText.join(' | ');
  }

  return `(${type})`;
}

// Recursively walks the block tree under a page, returning a flat list with
// depth for indentation. Table rows are included as children of their
// parent table, one level deeper, so their block IDs are visible right next
// to the table they belong to — this is the main point of this endpoint:
// Notion's own UI won't reliably give you a table row's block ID via
// "copy link," but the API returns it for free.
async function walkBlocks(blockId: string, depth: number, rows: BlockRow[]): Promise<void> {
  let cursor: string | undefined = undefined;
  do {
    const response: any = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    });

    for (const block of response.results) {
      rows.push({
        id: block.id,
        type: block.type,
        depth,
        preview: previewForBlock(block),
      });

      // Always descend into tables (to reach table_row IDs) and anything
      // else Notion flags as having children.
      if (block.type === 'table' || block.has_children) {
        await walkBlocks(block.id, depth + 1, rows);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawPageId = body?.pageId;
    if (!rawPageId || typeof rawPageId !== 'string') {
      return NextResponse.json({ error: 'Request body must include a "pageId" string (a Notion page URL or ID).' }, { status: 400 });
    }

    const pageId = extractNotionId(rawPageId);
    if (!pageId) {
      return NextResponse.json({ error: `Could not find a Notion page/block ID in "${rawPageId}".` }, { status: 400 });
    }

    const rows: BlockRow[] = [];
    await walkBlocks(pageId, 0, rows);

    return NextResponse.json({ pageId, blocks: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('[SETUP] list-blocks failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
