import { NextResponse } from 'next/server';
import { notion, explainNotionError } from '@/lib/notion';
import { extractNotionId } from '@/lib/notionId';

export const maxDuration = 60;

// Non-table, non-column blocks are returned flat, in page order, for
// visual context (headings/paragraphs render as read-only text so the
// layout reads like the real page) or as a fillable spot (images).
type SimpleBlockItem = {
  kind: 'simple';
  id: string;
  type: string;
  depth: number;
  preview: string;
};

// Tables are NOT flattened into their rows — they're returned as one
// structured unit with real column labels and per-row cell previews, so
// the client can render an actual grid that mirrors the Notion table
// exactly, with inputs aligned under the right column.
type TableBlockItem = {
  kind: 'table';
  id: string;
  depth: number;
  columns: string[]; // header labels (real header text, or "Column N" if the table has no header row)
  hasRealHeader: boolean;
  rows: { id: string; cells: string[] }[]; // data rows only — header row is never included here
};

// A Notion column_list is a container of side-by-side `column` blocks.
// Flattening these (the pre-this-fix behavior) loses exactly the
// information that matters — which items sit together in the same column
// vs. a sibling column — so it's returned as its own unit: one array of
// items PER COLUMN, letting the client render them side by side. Columns
// can nest (a column containing another column_list), which this handles
// naturally since parseChildren() is the same recursive function at every
// level.
type ColumnsBlockItem = {
  kind: 'columns';
  id: string;
  depth: number;
  columns: PageBlockItem[][];
};

type PageBlockItem = SimpleBlockItem | TableBlockItem | ColumnsBlockItem;

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

// Recursively parses the block tree under a container, returning items
// rather than mutating a shared list — this is what lets column_list
// handling recurse cleanly into each column and get back its own nested
// array, instead of everything flattening into one long list regardless
// of which column it came from.
async function parseChildren(blockId: string, depth: number): Promise<PageBlockItem[]> {
  const children = await fetchAllChildren(blockId);
  const items: PageBlockItem[] = [];

  for (const block of children) {
    if (block.type === 'table') {
      items.push(await describeTable(block, depth));
      continue; // table_row children are already captured inside describeTable
    }

    if (block.type === 'column_list') {
      const columnContainers = await fetchAllChildren(block.id); // each is type 'column'
      const columns = await Promise.all(
        columnContainers.map(col => parseChildren(col.id, depth + 1))
      );
      items.push({ kind: 'columns', id: block.id, depth, columns });
      continue; // column contents are already captured above
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
      const nested = await parseChildren(block.id, depth + 1);
      items.push(...nested);
    }
  }

  return items;
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

    const items = await parseChildren(pageId, 0);

    return NextResponse.json({ pageId, items });
  } catch (error) {
    const message = explainNotionError(error);
    console.error('[SETUP] list-blocks failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
