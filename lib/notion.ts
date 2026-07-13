import { Client, isNotionClientError, APIErrorCode } from '@notionhq/client';

// Single shared Notion client. NOTION_TOKEN is one integration token shared
// across every connector — per user decision, this never varies per page.
// If that ever changes, this becomes a per-connector lookup instead.
export const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Notion's API returns the same generic "object_not_found" error whether a
// page genuinely doesn't exist OR it exists but was never shared with this
// integration (Page/database → ••• menu → Connections → add integration).
// The latter is by far the more common cause when someone's just set up a
// new connector, so surface it specifically rather than a bare 404 — this
// is the #1 thing people forget to do, and Notion's own error message
// doesn't make the fix obvious unless you already know to look for it.
export function explainNotionError(error: unknown): string {
  if (isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound) {
    return (
      'Notion returned "object not found." This usually means the page (or a block on it) ' +
      'exists but hasn\'t been shared with this integration yet: open the page in Notion → ' +
      '••• menu (top right) → Connections → add the integration this app uses, then try again. ' +
      `Original error: ${error.message}`
    );
  }
  return error instanceof Error ? error.message : String(error);
}
