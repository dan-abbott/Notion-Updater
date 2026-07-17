import { fetchConnectorsFile, ConnectorConfig } from './github';

export type { ConnectorConfig };

// IMPORTANT: this reads connectors.json LIVE from GitHub on every call — it
// is deliberately NOT a static `import connectorsData from '../connectors.json'`.
//
// That static-import approach was the original design, and it had a real
// bug: connectors.json would get bundled into whatever code was deployed,
// meaning (a) every new code deployment could silently overwrite the live
// connector registry with whatever version happened to be in that deploy's
// working copy, and (b) changes made via the admin page only took effect
// on the NEXT deploy, not immediately. Fetching live from GitHub instead
// means connectors.json is pure runtime data — never part of the deployed
// code bundle, never at risk from a code-only release, and admin changes
// take effect on the very next sync request with no redeploy needed.
export async function getConnectorConfig(connectorId: string): Promise<ConnectorConfig> {
  const { connectors } = await fetchConnectorsFile();

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
