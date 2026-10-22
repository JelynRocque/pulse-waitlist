
// ---------------------------------------------------------------------------
// Update your shade (for people who joined before the shade finder and undertones)
// 1. On pulseskin.co/waitlist/, "Already on the waitlist?" asks for their email (form: "shade_link").
//    If that email is on the list, we email them a private link. The page never says whether it is.
// 2. The link opens the waitlist page in update mode (?update=TOKEN&e=EMAIL). They pick their gemstone
//    and undertone and save (form: "shade_update"). Their existing row's Skin tone is updated and the
//    time goes in the "Shade updated" column. No new row, no new invite code.
// The link only works for that one email: TOKEN is a signature made with SHADE_LINK_SECRET, a random
// value this script creates in Script Properties the first time it runs.
// ---------------------------------------------------------------------------

var SHADE_UPDATED_COL = 7; // column G
// sendShadeInvites: true = only people who ticked "Send me launch news"; false = everyone without an undertone.
var SHADE_INVITES_ONLY_OPTED_IN = false;
var SKIN_TONE_RE = /^(mst_(10|[1-9])(_(cool|neutral|warm|olive|red|unsure))?|prefer_not)$/;

function shadeToken_(email) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("SHADE_LINK_SECRET");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("SHADE_LINK_SECRET", secret);
  }
  var sig = Utilities.computeHmacSha256Signature(email, secret);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, "").slice(0, 32);
}

function shadeLink_(email) {
  return SITE_URL + "waitlist/?update=" + shadeToken_(email) + "&e=" + encodeURIComponent(email);
}

function findSignupRow_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var emails = sheet.getRange(2, 2, last - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).trim().toLowerCase() === email) return i + 2;
  }
  return -1;
}

function sendShadeLink_(data) {
  if (looksLikeBot_(data, MIN_SIGNUP_MS)) return ok_();
  var email = String(data.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 1) return ok_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIGNUPS);
  if (!sheet || findSignupRow_(sheet, email) < 0) return ok_();
  // One link per email every 10 minutes, so the button can't be used to flood someone's inbox.
  var cache = CacheService.getScriptCache();
  var key = "shade_link_" + Utilities.base64EncodeWebSafe(email).slice(0, 200);
  if (cache.get(key)) return ok_();
  cache.put(key, "1", 600);
  try { if (emailAllowed_()) sendShadeEmail_(email, false); } catch (err) { console.error(err); }
  return ok_();
}

function saveShade_(data) {
  if (looksLikeBot_(data, MIN_SIGNUP_MS)) return ok_();
  var email = String(data.email || "").trim().toLowerCase();
  var tone = String(data.skin_tone || "");
  if (!email || String(data.token || "") !== shadeToken_(email)) return ok_();
  if (!SKIN_TONE_RE.test(tone)) return ok_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIGNUPS);
  if (!sheet) return ok_();
  var row = findSignupRow_(sheet, email);
  if (row < 0) return ok_();
  if (sheet.getRange(1, SHADE_UPDATED_COL).getValue() !== "Shade updated") {
    sheet.getRange(1, SHADE_UPDATED_COL).setValue("Shade updated");
  }
  sheet.getRange(row, 3).setValue(tone);
  sheet.getRange(row, SHADE_UPDATED_COL).setValue(new Date());
  return ok_();
}

function sendShadeEmail_(email, invite) {
  var key = PropertiesService.getScriptProperties().getProperty("BREVO_API_KEY");
  if (!key) return;
  var link = shadeLink_(email);
  var intro = invite
    ? "Since you joined, Pulse added two things: a shade finder that uses your phone camera, and undertones inside each shade. Adding yours helps make sure early access includes every skin tone."
    : "Here's your link to add or update your shade on the Pulse waitlist.";
  var subject = invite ? "Add your shade to your Pulse waitlist spot" : "Update your shade on the Pulse waitlist";

  var text =
    intro + "\n\n" +
    "Pick your shade and undertone here (it takes about a minute):\n" + link + "\n\n" +
    "This link is just for you, so please don't share it. Your spot and invite link stay the same.\n\n" +
    "Jelyn\nFounder, Pulse\n\n" +
    "You're getting this because you joined the waitlist at pulseskin.co. Privacy notice: https://pulseskin.co/privacy/";

  var html =
    '<div style="background:#FFFBF7;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#261000;">' +
    '<div style="max-width:520px;margin:0 auto;">' +
    '<p style="font-family:Georgia,serif;font-size:13px;letter-spacing:6px;color:#191819;margin:0 0 28px;">PULSE</p>' +
    '<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:28px;line-height:1.2;margin:0 0 18px;">' + (invite ? "Add your shade." : "Update your shade.") + '</h1>' +
    '<p style="font-size:16px;line-height:1.6;margin:0 0 16px;">' + intro + '</p>' +
    '<p style="margin:24px 0 8px;"><a href="' + link + '" style="display:inline-block;background:#261000;color:#FFFBF7;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:999px;">Pick My Shade</a></p>' +
    '<p style="font-size:14px;line-height:1.5;margin:0 0 16px;color:#5B4436;">It takes about a minute. This link is just for you, so please don\'t share it. Your spot and invite link stay the same.</p>' +
    '<p style="font-size:16px;line-height:1.5;margin:24px 0 0;">Jelyn<br><span style="color:#5B4436;">Founder, Pulse</span></p>' +
    '<p style="font-size:12px;line-height:1.5;color:#5B4436;margin:36px 0 0;border-top:1px solid #E7D6C8;padding-top:14px;">You\'re getting this because you joined the waitlist at pulseskin.co. <a href="https://pulseskin.co/privacy/" style="color:#5B4436;">Privacy notice</a></p>' +
    '</div></div>';

  var res = UrlFetchApp.fetch("https://api.brevo.com/v3/smtp/email", {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": key, "accept": "application/json" },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: email }],
      replyTo: { email: FROM_EMAIL, name: "Jelyn" },
      subject: subject,
      htmlContent: html,
      textContent: text,
      tags: [invite ? "shade-invite" : "shade-link"]
    })
  });
  if (res.getResponseCode() >= 300) console.error("Brevo " + res.getResponseCode() + ": " + res.getContentText());
}

// Run from the editor when you're ready (select sendShadeInvites, click Run). Emails everyone who joined
// before undertones existed (no undertone saved yet) a link to add their shade. Each person gets it once;
// it stops at the daily email limit, so run it again the next day to finish if needed.
function sendShadeInvites() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIGNUPS);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var props = PropertiesService.getScriptProperties();
  var sent = JSON.parse(props.getProperty("SHADE_INVITES_SENT") || "{}");
  var rows = sheet.getRange(2, 2, last - 1, 5).getValues(); // Email, Skin tone, Invite code, Referred by, Email updates
  var count = 0;
  for (var i = 0; i < rows.length; i++) {
    var email = String(rows[i][0]).trim().toLowerCase();
    var tone = String(rows[i][1]);
    if (!email || sent[email] || (SHADE_INVITES_ONLY_OPTED_IN && String(rows[i][4]) !== "yes") || /_(cool|neutral|warm|olive|red|unsure)$/.test(tone) || tone === "prefer_not") continue;
    if (!emailAllowed_()) { console.warn("Daily email limit reached. Run again tomorrow to finish."); break; }
    sendShadeEmail_(email, true);
    sent[email] = 1; count++;
    props.setProperty("SHADE_INVITES_SENT", JSON.stringify(sent));
  }
  console.log("Shade invites sent: " + count);
}

// Run once from the editor to send yourself a sample of the invite email.
function testShadeInvite() {
  sendShadeEmail_(FROM_EMAIL, true);
}
