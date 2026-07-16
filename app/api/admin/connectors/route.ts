import { NextResponse } from 'next/server';
import { fetchConnectorsFile, commitConnectorsFile } from '@/lib/github';

// Auth for this route is enforced by middleware.ts (Basic Auth on
// /api/admin/*), not here — this route assumes it only ever runs for an
// already-authenticated request.

export async function GET() {
  try {
    const { connectors } = await fetchConnectorsFile();
    return NextResponse.json({ connectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ADMIN] Failed to fetch connectors:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Adds a new connector, or overwrites an existing one with the same ID —
// same endpoint for both, since the only difference is whether the ID was
// already present.
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connectorId: string | undefined = body?.connectorId?.trim();
    const notionPageId: string | undefined = body?.notionPageId?.trim();
    const appsScriptUrl: string | undefined = body?.appsScriptUrl?.trim();

    if (!connectorId || !notionPageId || !appsScriptUrl) {
      return NextResponse.json(
        { error: 'connectorId, notionPageId, and appsScriptUrl are all required.' },
        { status: 400 }
      );
    }

    const { connectors, sha } = await fetchConnectorsFile();
    const isNew = !connectors[connectorId];
    connectors[connectorId] = { notionPageId, appsScriptUrl };

    await commitConnectorsFile(
      connectors,
      sha,
      `${isNew ? 'Add' : 'Update'} connector "${connectorId}" via admin page`
    );

    return NextResponse.json({ connectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ADMIN] Failed to save connector:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectorId = searchParams.get('id');
    if (!connectorId) {
      return NextResponse.json({ error: 'Missing "id" query parameter.' }, { status: 400 });
    }

    const { connectors, sha } = await fetchConnectorsFile();
    if (!connectors[connectorId]) {
      return NextResponse.json({ error: `Connector "${connectorId}" not found.` }, { status: 404 });
    }
    delete connectors[connectorId];

    await commitConnectorsFile(connectors, sha, `Remove connector "${connectorId}" via admin page`);

    return NextResponse.json({ connectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ADMIN] Failed to delete connector:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
