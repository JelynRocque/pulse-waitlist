// Replace the "Skip duplicate emails" block inside doPost with this.
// Someone already on the list who submits the form again (from "Already on the waitlist? Add or
// update your shade") gets their shade saved on their existing row. No new row, no new invite
// code, no second confirmation email. Everything else about them stays the same.

    // Already on the list: save the shade they picked, keep everything else.
    var last = sheet.getLastRow();
    if (last > 1) {
      var emails = sheet.getRange(2, 2, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim().toLowerCase(); });
      var at = emails.indexOf(email);
      if (at !== -1) {
        var tone = String(data.skin_tone || "");
        if (SKIN_TONE_RE.test(tone)) {
          if (sheet.getRange(1, SHADE_UPDATED_COL).getValue() !== "Shade updated") {
            sheet.getRange(1, SHADE_UPDATED_COL).setValue("Shade updated");
          }
          sheet.getRange(at + 2, 3).setValue(tone);
          sheet.getRange(at + 2, SHADE_UPDATED_COL).setValue(new Date());
        }
        return ok_();
      }
    }
