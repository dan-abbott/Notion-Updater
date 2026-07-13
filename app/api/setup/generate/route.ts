import { NextResponse } from 'next/server';
import { generateNotionGsCode, generateMappingRows, GenerateInput } from '@/lib/generateConnectorFiles';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const dataSourceTab: string = body?.dataSourceTab;
    const connectorId: string | undefined = body?.connectorId;
    const preExportFunctionName: string | undefined = body?.preExportFunctionName;
    const charts: GenerateInput['charts'] = Array.isArray(body?.charts) ? body.charts : [];
    const tableRows: GenerateInput['tableRows'] = Array.isArray(body?.tableRows) ? body.tableRows : [];

    if (!dataSourceTab || typeof dataSourceTab !== 'string') {
      return NextResponse.json({ error: 'Request body must include a "dataSourceTab" string.' }, { status: 400 });
    }
    if (charts.length === 0 && tableRows.length === 0) {
      return NextResponse.json({ error: 'At least one chart or table row mapping is required.' }, { status: 400 });
    }

    const notionGsCode = generateNotionGsCode(preExportFunctionName);
    const mappingRows = generateMappingRows({ dataSourceTab, preExportFunctionName, charts, tableRows });

    const instructions = [
      '1. Paste the generated Notion.gs into your Google Sheet\'s Apps Script editor (Extensions > Apps Script), replacing/adding the Web App entry point file.',
      '2. Deploy it: Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Copy the resulting URL.',
      '3. Open the "Mapping" tab in your Google Sheet (create it if it doesn\'t exist yet) and paste the generated rows starting at cell A1.',
      preExportFunctionName
        ? `4. Confirm "${preExportFunctionName}" already exists somewhere in this Apps Script project — the generated code calls it directly and does not define it.`
        : '4. No pre-export function was configured for this connector — runPreExportStep() is a no-op.',
      connectorId
        ? `5. In the Notion-Updater repo, add this entry to connectors.json:\n{\n  "${connectorId}": {\n    "notionPageId": "<your Notion page ID>",\n    "appsScriptUrl": "<the Web App URL from step 2>"\n  }\n}`
        : '5. In the Notion-Updater repo, add an entry for this connector to connectors.json with the page ID and the Web App URL from step 2.',
      `6. Point this page's Notion button at: https://<your-vercel-domain>/api/notion-sync/${connectorId || '<connector-id>'}`,
    ].join('\n\n');

    return NextResponse.json({ notionGsCode, mappingRows, instructions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('[SETUP] generate failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
