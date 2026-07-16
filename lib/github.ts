// Reads and commits connectors.json directly via GitHub's Contents API —
// no new Google infrastructure needed (the alternative considered was a
// Google Sheet as the config source, which would've required a service
// account + Sheets API setup). This repo/branch/path are hardcoded since
// this client only ever has one purpose: this one file, in this one repo.
const GITHUB_OWNER = 'dan-abbott';
const GITHUB_REPO = 'Notion-Updater';
const GITHUB_BRANCH = 'main';
const CONNECTORS_PATH = 'connectors.json';

const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CONNECTORS_PATH}`;

export type ConnectorConfig = {
  notionPageId: string;
  appsScriptUrl: string;
};

export type ConnectorsFile = {
  connectors: Record<string, ConnectorConfig>;
  sha: string; // required by GitHub's API to commit an update to this exact version of the file
};

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is not set.');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

export async function fetchConnectorsFile(): Promise<ConnectorsFile> {
  const res = await fetch(`${CONTENTS_URL}?ref=${GITHUB_BRANCH}`, {
    headers: githubHeaders(),
    cache: 'no-store', // always read the current committed state, never a stale cached copy
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API error fetching connectors.json (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  let connectors: Record<string, ConnectorConfig>;
  try {
    connectors = JSON.parse(content);
  } catch {
    throw new Error('connectors.json in the repo is not valid JSON — fix it directly in GitHub before using this page.');
  }
  return { connectors, sha: data.sha };
}

// Commits a full replacement of connectors.json. `sha` must be the exact
// value returned by the most recent fetchConnectorsFile() call — GitHub
// rejects the write (409 Conflict) if the file has changed since, which is
// the built-in protection against two people committing over each other.
export async function commitConnectorsFile(
  connectors: Record<string, ConnectorConfig>,
  sha: string,
  message: string
): Promise<void> {
  const content = Buffer.from(JSON.stringify(connectors, null, 2) + '\n', 'utf-8').toString('base64');
  const res = await fetch(CONTENTS_URL, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify({ message, content, sha, branch: GITHUB_BRANCH }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 409) {
      throw new Error('connectors.json changed on GitHub since this page last loaded it — refresh and try again.');
    }
    throw new Error(`GitHub API error committing connectors.json (${res.status}): ${body.slice(0, 300)}`);
  }
}
