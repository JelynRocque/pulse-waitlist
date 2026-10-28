// ---------------------------------------------------------------------------
// Friends-and-family test: lets Pulse's backend read the signup list so the tester page
// (pulseskin.co/test/admin) fills itself from the waitlist. Read-only; nothing is written here.
// Setup (once):
//   1. Append this file to the script. Add to the top of doGet (create doGet if there is none):
//        function doGet(e) { if (e && e.parameter && e.parameter.form === "webtest_list") return webtestList_(e); return ContentService.createTextOutput("ok"); }
//   2. Project Settings > Script Properties > add WEBTEST_SYNC_KEY with a long random value (40+ characters).
//      Put the same value in Supabase > Edge Functions > Secrets as WAITLIST_SYNC_KEY.
//   3. Deploy > Manage deployments > pencil > Version: New version > Deploy (same web address).
// ---------------------------------------------------------------------------

function webtestList_(e) {
  var want = PropertiesService.getScriptProperties().getProperty("WEBTEST_SYNC_KEY");
  var got = String((e && e.parameter && e.parameter.key) || "");
  var out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  if (!want || !got || got.length !== want.length || !timingSafeEqual_(got, want)) {
    return out.setContent(JSON.stringify({ ok: false, error: "unauthorized" }));
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIGNUPS);
  var last = sheet ? sheet.getLastRow() : 0;
  var rows = [];
  if (last > 1) {
    var vals = sheet.getRange(2, 1, last - 1, 6).getValues();   // Joined, Email, Skin tone, Invite code, Referred by, Email updates
    for (var i = 0; i < vals.length; i++) {
      var email = String(vals[i][1] || "").trim().toLowerCase();
      if (!email || email.indexOf("@") < 1) continue;
      var joined = vals[i][0] instanceof Date ? vals[i][0].toISOString() : String(vals[i][0] || "");
      rows.push({ email: email, joined: joined, tone: String(vals[i][2] || ""), updates: String(vals[i][5] || "") === "yes" });
    }
  }
  return out.setContent(JSON.stringify({ ok: true, rows: rows }));
}

function timingSafeEqual_(a, b) {
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
