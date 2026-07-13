import { NextResponse } from 'next/server';
import { generateNotionGsCode } from '@/lib/generateConnectorFiles';

// Step 1 of the setup wizard: generates Notion.gs. This never depends on
// any chart/table mapping — it's the same generic file for every connector
// except for the pre-export line — so it can be produced before a Notion
// page has even been chosen.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const preExportFunctionName: string | undefined = body?.preExportFunctionName;

    const notionGsCode = generateNotionGsCode(preExportFunctionName);
    return NextResponse.json({ notionGsCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('[SETUP] generate-script failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
