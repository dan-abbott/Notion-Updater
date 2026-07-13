import { NextResponse } from 'next/server';
import { notion, explainNotionError } from '@/lib/notion';
import { extractNotionId } from '@/lib/notionId';

export const maxDuration = 60;

// Non-table blocks are returned flat, in page order, for visual context
// (headings/paragraphs render as read-only text so the layout reads like
// the real page) or as a fillable spot (images). Tables are NOT flattened
// into their rows — they're returned as one structured unit with real
// column labels and per-row cell previews, so the client can render an
// actual grid that mirrors the Notion table exactly, with inputs aligned
// under the right column.
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
  columns: string[]; // header labels (real header text, or "Column N" if the table has no header row)
  hasRealHeader: boolean;
  rows: { id: string; cells: string[] }[]; // data rows only — header row is never included here
};

type PageBlockItem = SimpleBlockItem | TableBlockItem;

function textPreview(block: any): string {
  const type = block.type;
  const text = block[type]?.rich_text?.map((rt: any) => rt.plain_text).join('') ?? '';
  return text.trim();
}

function cellText(cell: any[]): string {
  return cell.map((rt: any) => rt.plain_text).join('').trim();
}

async function fetchAllChildren(blockId: string): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response: any = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function describeTable(block: any, depth: number): Promise<TableBlockItem> {
  const tableRows = await fetchAllChildren(block.id);
  const hasRealHeader = Boolean(block.table?.has_column_header) && tableRows.length > 0;

  let columns: string[];
  let dataRows: any[];

  if (hasRealHeader) {
    const headerCells: any[][] = tableRows[0].table_row?.cells ?? [];
    columns = headerCells.map(cell => cellText(cell) || 'Column');
    dataRows = tableRows.slice(1);
  } else {
    const width = block.table?.table_width ?? (tableRows[0]?.table_row?.cells?.length ?? 0);
    columns = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    dataRows = tableRows;
  }

  return {
    kind: 'table',
    id: block.id,
    depth,
    columns,
    hasRealHeader,
    rows: dataRows.map(row => ({
      id: row.id,
      cells: (row.table_row?.cells ?? []).map((cell: any[]) => cellText(cell)),
    })),
  };
}

// Recursively walks the block tree under a page. Tables are described as a
// single structured unit (see describeTable) rather than flattened into
// individual table_row entries — this is what lets the client render an
// actual grid mirroring the Notion table, instead of a flat list of rows.
async function walkBlocks(blockId: string, depth: number, items: PageBlockItem[]): Promise<void> {
  const children = await fetchAllChildren(blockId);

  for (const block of children) {
    if (block.type === 'table') {
      items.push(await describeTable(block, depth));
      continue; // table_row children are already captured inside describeTable
    }

    let preview: string;
    if (block.type === 'paragraph' || block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
      preview = textPreview(block);
    } else if (block.type === 'image') {
      const url = block.image?.type === 'external' ? block.image.external?.url : block.image?.file?.url;
      preview = url ? `Currently: ${url.slice(0, 50)}${url.length > 50 ? '...' : ''}` : '(empty image)';
    } else {
      preview = '';
    }

    items.push({ kind: 'simple', id: block.id, type: block.type, depth, preview });

    if (block.has_children) {
      await walkBlocks(block.id, depth + 1, items);
    }
  }
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

    const items: PageBlockItem[] = [];
    await walkBlocks(pageId, 0, items);

    return NextResponse.json({ pageId, items });
  } catch (error) {
    const message = explainNotionError(error);
    console.error('[SETUP] list-blocks failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
