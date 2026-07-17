// Google Sheets URLs look like:
//   https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit#gid=0
// The ID is the path segment right after /d/. Also accepts a bare ID pasted
// directly (no fixed format to validate against — Sheet IDs aren't UUIDs
// like Notion's, they're arbitrary-length base64-ish strings — so a bare
// input with no slashes is just passed through as-is).
export function extractGoogleSheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // No URL pattern matched — if it doesn't look like a URL at all, assume
  // it's already a bare ID and use it as-is.
  if (!trimmed.includes('/') && !trimmed.includes('http')) {
    return trimmed;
  }

  return null;
}
