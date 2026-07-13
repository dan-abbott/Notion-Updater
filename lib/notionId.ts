// Notion IDs appear either as raw 32-char hex (dashed or not) or embedded in
// a page URL, usually as the last hyphen-separated segment before any `?`/`#`,
// or after a `#` for a specific block link. Accepts either form and returns
// a normalized dashed UUID, which the Notion API accepts.
export function extractNotionId(input: string): string | null {
  const trimmed = input.trim();

  // If there's a #fragment (block link), prefer that — it's the most
  // specific thing the person could have pasted.
  const hashIndex = trimmed.indexOf('#');
  const candidates: string[] = [];
  if (hashIndex !== -1) {
    candidates.push(trimmed.slice(hashIndex + 1));
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    // Strip query string / fragment if present, then look for a 32-char hex
    // run anywhere in the remaining string (covers both bare IDs and URLs
    // like .../Page-Title-<id>).
    const cleaned = candidate.split('?')[0];
    const match = cleaned.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (match) {
      return dashifyId(match[1]);
    }
  }

  return null;
}

function dashifyId(id: string): string {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32) return id; // return as-is, let Notion's API reject it with a clear error
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
