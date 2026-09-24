// Google Apps Script (script.google.com), runs inside the optemate Google account.
// Reads F5Bot alert emails, writes each Reddit link to a sheet named "F5Bot alerts", every 15 minutes.
// Run `setup` once by hand and approve the permissions; it creates the sheet, the label and the timer.
const SHEET_NAME = "F5Bot alerts";
const DONE_LABEL = "f5bot-done";

function setup() {
  getSheet();
  GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("pull").timeBased().everyMinutes(15).create();
  pull();
  Logger.log("Sheet: " + getSheet().getParent().getUrl());
}

function getSheet() {
  const files = DriveApp.getFilesByName(SHEET_NAME);
  const ss = files.hasNext() ? SpreadsheetApp.open(files.next()) : SpreadsheetApp.create(SHEET_NAME);
  const sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(["found_at", "keyword", "url", "excerpt", "message_id"]);
  return sh;
}

function pull() {
  const sh = getSheet();
  const label = GmailApp.getUserLabelByName(DONE_LABEL);
  const threads = GmailApp.search('from:f5bot.com -label:' + DONE_LABEL, 0, 50);
  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const text = msg.getPlainBody();
      const date = msg.getDate().toISOString();
      const seen = new Set();
      const re = /https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^\s)>\]]+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = m[0].replace(/[.,]+$/, "");
        if (seen.has(url)) continue;
        seen.add(url);
        const before = text.slice(Math.max(0, m.index - 600), m.index);
        const kw = (before.match(/keyword[:\s]+"?([^"\n]+)"?/gi) || []).pop() || "";
        const excerpt = text.slice(m.index + url.length, m.index + url.length + 300).replace(/\s+/g, " ").trim();
        sh.appendRow([date, kw.replace(/keyword[:\s]+"?/i, "").replace(/"$/, "").trim(), url, excerpt, msg.getId()]);
      }
    });
    thread.addLabel(label);
  });
}
