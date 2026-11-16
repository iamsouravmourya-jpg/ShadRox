/**
 * ShadRox feedback receiver — owner setup only.
 *
 * 1. Create a Google Sheet (columns A=Date, B=Bug, C=Feature are created here).
 * 2. Create the script one of two ways:
 *    a) Standalone: open script.google.com > New project, paste this, and set
 *       SHEET_ID below to the ID in the sheet URL (/d/<ID>/edit).
 *    b) Bound: in the sheet, Extensions > Apps Script, paste this, leave
 *       SHEET_ID empty. Use this unless the menu opens a Drive error page,
 *       which happens when the browser has several Google accounts signed in.
 * 3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 * 4. Copy the /exec URL into .env as SHADROX_FEEDBACK_WEBHOOK and rebuild the app.
 *
 * The URL is baked into the client obfuscated, so treat this as a write-only
 * endpoint: it accepts a message, stamps the date, and returns nothing useful.
 */

// Standalone projects only. Bound scripts can leave this empty.
var SHEET_ID = '';

var RATE_LIMIT_PER_HOUR = 50;
var RATE_WINDOW_MS = 60 * 60 * 1000;
var MIN_MESSAGE = 3;
var MAX_MESSAGE = 4000;

function doPost(e) {
  var body, kind, message;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
    kind = body && body.kind;
    message = body && typeof body.message === 'string' ? body.message.trim() : '';
  } catch (err) {
    return respond({ ok: false, error: 'bad_request' });
  }
  if (kind !== 'bug' && kind !== 'feature') return respond({ ok: false, error: 'bad_request' });
  if (message.length < MIN_MESSAGE || message.length > MAX_MESSAGE) {
    return respond({ ok: false, error: 'bad_request' });
  }

  var ss;
  try {
    ss = SHEET_ID ? SpreadsheetApp.openById(String(SHEET_ID).trim()) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    return respond({ ok: false, error: 'sheet_unavailable' });
  }
  if (!ss) return respond({ ok: false, error: 'sheet_unavailable' });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return respond({ ok: false, error: 'busy' });
  }
  try {
    if (!consumeQuota()) return respond({ ok: false, error: 'rate_limited' });
    var sheet = ss.getSheets()[0];
    if (sheet.getLastRow() === 0) sheet.appendRow(['Date', 'Bug', 'Feature']);
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1).setValue(
      Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss')
    );
    // Plain-text format keeps a leading "=" in a message from becoming a formula.
    sheet.getRange(row, kind === 'bug' ? 2 : 3).setNumberFormat('@').setValue(message);
    return respond({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput('Not found').setMimeType(ContentService.MimeType.TEXT);
}

function consumeQuota() {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var windowStart = Number(props.getProperty('windowStart') || 0);
  var count = windowStart && now - windowStart < RATE_WINDOW_MS ? Number(props.getProperty('count') || 0) : 0;
  if (!windowStart || now - windowStart >= RATE_WINDOW_MS) windowStart = now;
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  props.setProperties({ windowStart: String(windowStart), count: String(count + 1) });
  return true;
}

function respond(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}
