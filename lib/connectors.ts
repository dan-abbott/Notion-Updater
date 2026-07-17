import connectorsData from '../connectors.json';

export type ConnectorConfig = {
  notionPageId: string;
  appsScriptUrl: string;
  // Google Sheet ID this connector's script is bound to. Purely informational
  // — nothing in the sync pipeline reads it, since the Apps Script deployment
  // (appsScriptUrl) is already implicitly tied to one specific spreadsheet.
  // It exists so a connector's Sheet can be identified/linked directly from
  // connectors.json without hunting for it, and so the admin page's "Edit
  // mapping" flow has it available to pass along. Optional since connectors
  // registered before this field existed won't have it.
  sheetId?: string;
};

// One entry per connected Notion page. Each page has its own Google Sheet
// + Apps Script deployment (appsScriptUrl) and its own target page
// (notionPageId). NOTION_TOKEN stays a single shared env var across every
// connector — see lib/notion.ts.
//
// To add a new connector: add an entry to connectors.json (via a PR/commit
// — see ADDING_A_CONNECTOR.md), then point that page's Notion button at
// /api/notion-sync/<the new key>.
const connectors = connectorsData as Record<string, ConnectorConfig>;

export function getConnectorConfig(connectorId: string): ConnectorConfig {
  const config = connectors[connectorId];
  if (!config) {
    const known = Object.keys(connectors).join(', ') || '(none configured)';
    throw new Error(
      `Unknown connector "${connectorId}". Known connectors: ${known}. ` +
      `Check connectors.json and the URL the Notion button is pointed at.`
    );
  }
  if (!config.notionPageId || !config.appsScriptUrl) {
    throw new Error(`Connector "${connectorId}" is missing notionPageId or appsScriptUrl in connectors.json.`);
  }
  return config;
}
