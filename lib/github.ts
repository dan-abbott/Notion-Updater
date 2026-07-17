// Reads and commits JSON files directly via GitHub's Contents API — no new
// Google infrastructure needed for either connectors.json or the per-connector
// mapping files. Repo/branch are hardcoded since this client only ever has
// one purpose: files in this one repo, on this one branch.
const GITHUB_OWNER = 'dan-abbott';
const GITHUB_REPO = 'Notion-Updater';
const GITHUB_BRANCH = 'main';
const CONNECTORS_PATH = 'connectors.json';

function contentsUrl(path: string): string {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
}

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

export type GithubJsonFile<T> = {
  data: T;
  sha: string | null; // null means the file doesn't exist yet — commit as a new file
};

// Reads and JSON-parses any file in the repo. Returns `sha: null` (rather
// than throwing) if the file doesn't exist yet — callers that create files
// on first use (like per-connector mapping files) treat that as "start
// from an empty default," not an error.
async function fetchJsonFile<T>(path: string, emptyDefault: T): Promise<GithubJsonFile<T>> {
  const res = await fetch(`${contentsUrl(path)}?ref=${GITHUB_BRANCH}`, {
    headers: githubHeaders(),
    cache: 'no-store', // always read the current committed state, never a stale cached copy
  });

  if (res.status === 404) {
    return { data: emptyDefault, sha: null };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API error fetching ${path} (${res.status}): ${body.slice(0, 300)}`);
  }

  const responseData = await res.json();
  const content = Buffer.from(responseData.content, 'base64').toString('utf-8');
  let data: T;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(`${path} in the repo is not valid JSON — fix it directly in GitHub first.`);
  }
  return { data, sha: responseData.sha };
}

// Commits a full replacement of any JSON file in the repo. `sha` must be
// the exact value returned by the most recent fetchJsonFile() call for
// this same path (or `null` for a brand-new file) — GitHub rejects the
// write (409 Conflict) if the file changed since, which is the built-in
// protection against two people committing over each other.
async function commitJsonFile<T>(path: string, data: T, sha: string | null, message: string): Promise<void> {
  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8').toString('base64');
  const body: Record<string, unknown> = { message, content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(path), {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    if (res.status === 409) {
      throw new Error(`${path} changed on GitHub since this page last loaded it — refresh and try again.`);
    }
    throw new Error(`GitHub API error committing ${path} (${res.status}): ${responseBody.slice(0, 300)}`);
  }
}

export type ConnectorConfig = {
  notionPageId: string;
  appsScriptUrl: string;
  sheetId?: string;
};

export async function fetchConnectorsFile(): Promise<{ connectors: Record<string, ConnectorConfig>; sha: string }> {
  const { data, sha } = await fetchJsonFile<Record<string, ConnectorConfig>>(CONNECTORS_PATH, {});
  if (!sha) {
    throw new Error('connectors.json does not exist in the repo — this should never happen; check the repo directly.');
  }
  return { connectors: data, sha };
}

export async function commitConnectorsFile(
  connectors: Record<string, ConnectorConfig>,
  sha: string,
  message: string
): Promise<void> {
  await commitJsonFile(CONNECTORS_PATH, connectors, sha, message);
}

export type MappingChart = {
  blockId: string;
  tabName: string;
  chartTitle: string;
};

export type MappingTableRow = {
  blockId: string;
  tabName: string;
  sourceCells: (string | null)[];
};

export type MappingFile = {
  charts: MappingChart[];
  tableRows: MappingTableRow[];
};

const EMPTY_MAPPING: MappingFile = { charts: [], tableRows: [] };

function mappingPath(connectorId: string): string {
  // connectorId is already constrained to URL-safe characters by convention
  // (short, hyphenated, e.g. "amber-otter") — not re-sanitized here, but
  // worth keeping in mind if that constraint is ever relaxed.
  return `mappings/${connectorId}.json`;
}

// Returns { data: { charts: [], tableRows: [] }, sha: null } for a connector
// that doesn't have a mapping file yet — this is the normal case the first
// time someone uses the wizard for a given connector, not an error.
export async function fetchMappingFile(connectorId: string): Promise<GithubJsonFile<MappingFile>> {
  return fetchJsonFile<MappingFile>(mappingPath(connectorId), EMPTY_MAPPING);
}

export async function commitMappingFile(
  connectorId: string,
  mapping: MappingFile,
  sha: string | null,
  message: string
): Promise<void> {
  await commitJsonFile(mappingPath(connectorId), mapping, sha, message);
}
