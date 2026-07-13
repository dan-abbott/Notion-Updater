import { NextResponse } from 'next/server';
import { generateMappingRows, ChartMapping, TableRowMapping } from '@/lib/generateConnectorFiles';

// Step 2 of the setup wizard: generates the Mapping sheet rows from the
// chart/table-row mappings collected while browsing the Notion page's
// blocks. Each mapping carries its own sheet tab name — data can come from
// any number of tabs, not just one shared tab.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const charts: ChartMapping[] = Array.isArray(body?.charts) ? body.charts : [];
    const tableRows: TableRowMapping[] = Array.isArray(body?.tableRows) ? body.tableRows : [];

    if (charts.length === 0 && tableRows.length === 0) {
      return NextResponse.json({ error: 'At least one chart or table row mapping is required.' }, { status: 400 });
    }

    const mappingRows = generateMappingRows(charts, tableRows);
    return NextResponse.json({ mappingRows });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('[SETUP] generate-mapping failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
