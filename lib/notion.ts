import { Client } from '@notionhq/client';

// Single shared Notion client. NOTION_TOKEN is one integration token shared
// across every connector — per user decision, this never varies per page.
// If that ever changes, this becomes a per-connector lookup instead.
export const notion = new Client({ auth: process.env.NOTION_TOKEN });
