import { NextResponse } from 'next/server';
import { fetchMappingFile, commitMappingFile, MappingFile } from '@/lib/github';

// This route is intentionally NOT behind admin auth (unlike
// /api/admin/connectors) — it's part of the same /setup wizard flow as
// list-blocks/generate-script/generate-mapping, none of which are gated
// either. It commits directly to the repo (a mapping JSON file per
// connector), same tradeoff already accepted for the rest of /setup: this
// is an internal tool with no real access control on who can reach it,
// only on who can reach /admin's connector *registration* (the higher-
// stakes action, since it affects live routing).

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectorId = searchParams.get('connectorId');
    if (!connectorId) {
      return NextResponse.json({ error: 'Missing "connectorId" query parameter.' }, { status: 400 });
    }

    const { data } = await fetchMappingFile(connectorId);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SETUP] Failed to fetch mapping file:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Commits a FULL replacement of this connector's mapping file — the caller
// (the wizard) is expected to have loaded the existing mapping first (via
// GET) and merged in any changes, so what's sent here already represents
// the complete, current state, not just what changed in this session.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connectorId: string | undefined = body?.connectorId?.trim();
    const mapping: MappingFile = {
      charts: Array.isArray(body?.charts) ? body.charts : [],
      tableRows: Array.isArray(body?.tableRows) ? body.tableRows : [],
    };

    if (!connectorId) {
      return NextResponse.json({ error: 'Missing "connectorId".' }, { status: 400 });
    }

    // Re-fetch the sha fresh, right before committing — never trust a sha
    // passed from the client, which could be stale by the time this runs.
    const { sha } = await fetchMappingFile(connectorId);
    await commitMappingFile(connectorId, mapping, sha, `Update mapping for connector "${connectorId}" via setup wizard`);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SETUP] Failed to commit mapping file:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
