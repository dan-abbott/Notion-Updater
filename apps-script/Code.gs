/**
 * This script's ONLY job now is to export every chart on the sheet as a
 * base64-encoded PNG and hand them back as JSON. It does NOT talk to
 * ImgBB and does NOT talk to Notion anymore — the Vercel middleware
 * (app/api/notion-sync/route.ts) owns the Vercel Blob upload and the
 * Notion anchor search/update entirely. Keeping that logic in one place
 * (the middleware) avoids having two systems independently trying to find
 * and update the same Notion blocks.
 *
 * Response shape:
 *   { "charts": [ { "title": "Monthly Burn Rate", "imageBase64": "..." }, ... ] }
 *
 * IMPORTANT: Deploy this as a Web App (Deploy > New deployment > Web app)
 * with "Execute as: Me" and "Who has access" set appropriately for your
 * middleware to call it, then put that deployment URL in Vercel's
 * GOOGLE_APPS_SCRIPT_URL environment variable.
 */

const CONFIG = {
  SHEET_NAME: "Testing",
};

function doGet(e) {
  try {
    const charts = exportAllChartsAsJson();
    return ContentService
      .createTextOutput(JSON.stringify({ charts }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function exportAllChartsAsJson() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw new Error("Could not find sheet '" + CONFIG.SHEET_NAME + "'");
  }

  const charts = sheet.getCharts();
  if (charts.length === 0) {
    throw new Error("No charts found on sheet '" + CONFIG.SHEET_NAME + "'");
  }

  const result = [];

  for (let i = 0; i < charts.length; i++) {
    const chart = charts[i];
    const chartTitle = chart.getOptions().get('title');

    if (!chartTitle) {
      Logger.log("⚠️ Skipping chart " + (i + 1) + ": no title set in Google Sheets.");
      continue;
    }

    const imageBlob = chart.getAs('image/png');
    const base64Data = Utilities.base64Encode(imageBlob.getBytes());

    result.push({
      title: chartTitle,
      imageBase64: base64Data,
    });
  }

  return result;
}
