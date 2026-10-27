/*
 * Pulse "Find My Shade" camera helper (v4: two readings that check each other, nothing to hold).
 *
 * v4 (Oct 27, 2026): deep skin was still sometimes told Pearl or Selenite. The
 * cause was in the math, not the lighting: v3 trusted the eye whites alone, and
 * whenever the pixels it took for eye white were really lash shadow, lid or the
 * dark rim of the iris (hooded, deep-set or narrow eyes; eyes slightly down),
 * the "whites" came out dark and the skin read lighter by comparison, with no
 * limit. A deep-skinned face with shadowed eyes went all the way to Pearl, and
 * the v3.2 stretch then pushed it further. v4 changes four things:
 *
 *  1. A second reading from the skin's own color. Melanin absorbs blue far
 *     more than red, so the red:blue and green:blue balance of the cheek tracks
 *     depth and is unaffected by how bright or dark the camera made the frame.
 *     Color alone can't tell very light from very deep (both are low in color),
 *     so the iris sets the range: it is visible whenever the eye is open at
 *     all, hooded or not, and it is dark brown on nearly everyone with deeper
 *     skin. Skin barely brighter than the iris is deep; skin many times
 *     brighter is light. Within the range, the color fit (126 foundation
 *     shades + the 10 Monk swatches) lands within ~5 points of depth typically.
 *  2. Eye whites are read strictly: only pixels in the middle band of the eye,
 *     beside the iris, low in color and brighter than the cheek. Lashes, lids
 *     and iris rim no longer count. If too few remain (hooded eyes), the eye
 *     reading is simply not used; the person is not refused.
 *  3. The two readings check each other. A contaminated eye reading can only
 *     make skin look LIGHTER, never deeper, so an eye reading that says deep is
 *     trusted, and an eye reading that says light must be confirmed by the
 *     skin-color reading. If they disagree by two gemstones or more, the eye
 *     reading loses. The iris range is also a hard limit: a face whose skin is
 *     about as bright as its iris is never shown Pearl, Selenite or Moonstone.
 *  4. The v3.2 contrast stretch now only applies to readings deeper than the
 *     calibration point, where it was measured to help. It never pushes a
 *     reading lighter.
 *
 * Honest limits: the color fit comes from brand swatches and the Monk scale,
 * not yet from Pulse users, and phone cameras lift shadows on deep skin. The
 * final constants (irisDeep, irisLight, the two color fits) must be checked
 * against a real panel of people who know their shade, at least half of them
 * Monk 7-10, on iPhone and Android. ?sfdebug=1 shows every intermediate value
 * so that panel can be run. Launch gate: 90%+ of readings on the right
 * gemstone or its neighbor for EVERY gemstone, and zero readings 3+ off.
 *
 * v3.2 (Oct 24, 2026): a contrast correction for deeper skin. Tested on the
 * Monk Skin Tone Examples set (Google/TONL, 19 people, Monk 1-10; licensed for
 * research and testing only, never for training models), v3.1 read deep skin
 * far too light: Monk 8-10 came out 20-30 points of depth lighter than the
 * Monk scale's own swatches, which is 3-4 gemstones (Onyx read as Bronzite).
 * Two things squeeze the gap between skin and eye whites on deeper skin:
 *  - Phone cameras brighten dark faces and compress highlights, so the skin
 *    and the eye whites end up closer together than they really are.
 *  - Eye whites carry their own pigment more often on deeper skin
 *    (complexion-associated conjunctival melanosis: about 92% of Black, 36% of
 *    Asian, 28% of Hispanic and 5% of white adults; Shields et al., Survey of
 *    Ophthalmology 2004), and darker eye whites make skin look lighter next to
 *    them.
 * The fix stretches depth away from the calibration point (depth 49, where
 * the eye-white scale was set on a person whose foundation shade is known), so
 * that person's result doesn't move, lighter readings move lighter and deeper
 * readings move deeper. The stretch (1.3) is the slope measured across the 19
 * test subjects, checked by leaving each person out in turn: the typical
 * person's error fell from 13.7 to 4.5 points of depth and the deep-skin
 * error from +20-30 to under 10. Because single readings still vary by about
 * a gemstone, "between two gemstones" now covers 2.5 points either side of
 * a boundary instead of 1.5. Next step: replace the test-set slope with
 * readings from Pulse users who know their foundation shade.
 *
 * v3.1 (Oct 22, 2026): people are asked to take off glasses, sunglasses, hats
 * and anything near their eyes; the eyes are read at the camera's full
 * resolution; and a reading is refused unless both eyes are wide open and
 * looking straight at the camera. Glasses, squinting and side glances shaded
 * the eye whites and made deeper skin read lighter (a friend with deep skin,
 * wearing glasses, got Moonstone). Add ?sfdebug=1 to the page URL to see the
 * measured depth on the result screen, for calibration.
 *
 * Why the eyes: phone cameras brighten or darken every face so it looks
 * "normal", which made v1 give most people the same middle shade. The whites
 * of the eyes are in the same light as the skin and go through the same
 * camera adjustments, and they're close to white on everyone. Comparing
 * cheek skin with the eye whites cancels out the camera's brightness changes.
 *
 * The comparison gives the skin's depth (CIELAB lightness, L*). Each gemstone
 * is a band of depth, shared with the shade library (assets/shade-library.js),
 * where 126 foundation shades from Pat McGrath, Fenty and Juvia's Place sit in
 * the same bands. The camera picks the gemstone; the person picks their
 * undertone, because lighting tints color too much for a camera to judge
 * warm versus cool reliably.
 *
 * Face tracking (MediaPipe Face Mesh, Apache 2.0, served from /assets/vendor)
 * runs on the device to find the cheeks and eyes. No image, video or face
 * measurement is saved, uploaded or sent anywhere. Only the shade the person
 * picks is submitted, the same as tapping it by hand.
 *
 * Use: add a button with data-shade-finder="<radio name>" next to a group of
 * ten shade radios, lightest first. Each radio's label needs an <i> swatch and
 * the shade name as text. Radios with value "prefer_not" are skipped.
 */
(function () {
  "use strict";

  var SETTINGS = {
    // Light reflected by the whites of the eyes, as the camera sees them
    // (lids and lashes shade them). Sets the overall light-to-deep scale.
    // Calibrated Oct 22, 2026 on one person who wears Pat McGrath Medium
    // Deep 24 and Fenty 486W (both depth ~49, Tiger's Eye).
    // Lower it if results run too light; raise it if too deep.
    scleraReflectance: 0.34,
    // How much to trust the eye whites for color balance (0 = trust the
    // camera's own white balance, 1 = treat eye whites as pure white).
    // Eye whites are often slightly yellow, so this stays partial.
    whiteBalanceFromEyes: 0.75,
    // v3.2 contrast correction: depth is stretched by this much away from
    // stretchAnchor (the depth the eye-white scale was calibrated at), undoing
    // the camera's compression and eye-white pigment on deeper skin. 1 = off.
    contrastStretch: 1.3,
    stretchAnchor: 49,
    // Within this much depth of a gemstone boundary, the result says it's
    // between the two gemstones.
    betweenMargin: 2.5,
    // Eyes must be at least this open (height / width of the eye outline) and
    // the iris must sit in the middle of the eye (looking straight ahead).
    // Lower than v3 so hooded and narrow eyes get through to the skin-color
    // reading instead of being refused forever.
    minEyeOpen: 0.16,
    // Clean eye-white pixels (analysis-size) needed before the eye reading is used at all.
    minWhitePixels: 24,
    // Eye-white pixels must be at least this bright compared with the cheek
    // (lids shade them, so a little under 1 is normal on fair skin).
    scleraMinRatio: 0.85,
    // Range cues (which color fit to use). Skin brightness / iris brightness:
    // at or below irisDeep (brown iris) the skin is deep; at or above irisLight
    // it is light. A blue/green/gray iris means light skin on its own.
    irisDeep: 3.0,
    irisLight: 6,
    // Brightest sliver of the eye region / cheek: at or above eyeBrightDeep the
    // skin is deep (eye whites far brighter than skin only happens on deep
    // skin); at or below eyeBrightLight it is light (cheeks outshine eye whites).
    eyeBrightDeep: 3.5,
    eyeBrightLight: 0.8,
    // Below eyeBrightNone no eye white is visible at all (eyes nearly shut, or
    // all lash): refuse and ask for wider eyes rather than guess.
    eyeBrightNone: 0.35,
    // Under-eye skin / cheek: below minUnderEye the eyes sit in brow shadow,
    // refuse and ask to face the light; between that and compensateUnderEye the
    // shared shadow is corrected out of the eye whites and iris.
    minUnderEye: 0.72,
    compensateUnderEye: 0.95,
    // Multiplier on the skin's color ratios before the color fit (1 = as fitted
    // on brand swatches). Phone tone curves compress color; the panel sets this.
    colorContrast: 1.0,
    // Depth from the skin's color balance: depth = a + b*ln(R/B) + c*ln(G/B),
    // fitted on 126 foundation shades + the Monk swatches, per range.
    colorFit: { light: [94.60, -46.07, 48.71], mid: [75.08, -44.00, 61.95], deep: [35.63, -24.44, 51.98] },
    // Eye and skin readings this far apart (two gemstones) means the eye reading is contaminated.
    disagreeDepth: 14,
    // Hard limits from the iris range: deep skin is never shown lighter than
    // this, light skin never deeper than this.
    deepCeiling: 62,
    lightFloor: 34,
    framesPerReading: 8,
    goodChecksBeforeAuto: 2,
    // After a refused reading, its message stays up this long before "Perfect" can show again.
    holdIssueMs: 3000,
    analysisWidth: 720
  };

  // Lower depth limit of gemstones 1-9 (Pearl is open above, Onyx open below).
  var EDGES = (window.PULSE_SHADES && window.PULSE_SHADES.edges) || [83, 76, 69, 62, 55, 48, 41, 34, 27];
  var GEMSTONES = EDGES.length + 1;
  // ?sfdebug=1 shows every intermediate value on the result screen.
  // ?sfcal=1 is calibration mode for the real-person panel: debug values plus a
  // Copy Reading button that copies one line of numbers (no image, nothing sent
  // anywhere) to paste into the panel sheet next to the person's known shade.
  var CAL = /[?&]sfcal=1/.test(location.search);
  var DEBUG = CAL || /[?&]sfdebug=1/.test(location.search);
  // A page can override a few messages (the Pulse app's built-in finder page points people to phone Settings).
  var CONFIG = window.PulseShadeFinderConfig || {};

  var BASE = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/[^/]*$/, "") : "/assets/";
  })();

  // ---------- Color math ----------
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  var LIN = new Float32Array(256);
  for (var li = 0; li < 256; li++) LIN[li] = lin(li);
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
  function labFromLinear(R, G, B) {
    var x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    var y = (0.2126 * R + 0.7152 * G + 0.0722 * B);
    var z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function ita(lab) { return Math.atan2(lab[0] - 50, lab[2]) * 180 / Math.PI; }
  function median(arr) {
    var s = arr.slice().sort(function (p, q) { return p - q; });
    var n = s.length; if (!n) return NaN;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // ---------- Face mesh landmark indices ----------
  var EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  var EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
  var IRIS_L = [468, 469, 470, 471, 472], IRIS_R = [473, 474, 475, 476, 477];
  var CHEEKS = [50, 280, 205, 425]; // upper and lower cheeks, both sides
  var FACE_SIDES = [234, 454];

  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // Reads skin and eye whites from one frame. lm = face landmarks scaled to pixels.
  // hi (optional) = {ctx, scale}: the same frame at full camera resolution, used for the eyes.
  function analyzeFrame(ctx, w, h, lm, hi) {
    var out = { face: !!lm };
    var frame = ctx.getImageData(0, 0, w, h).data;
    var fs = 0, fc = 0;
    for (var p = 0; p < frame.length; p += 64) { fs += (frame[p] + frame[p + 1] + frame[p + 2]) / 3; fc++; }
    out.frameMean = fs / fc;
    if (!lm) return out;

    var faceW = Math.hypot(lm[FACE_SIDES[0]][0] - lm[FACE_SIDES[1]][0], lm[FACE_SIDES[0]][1] - lm[FACE_SIDES[1]][1]);
    var cx = (lm[FACE_SIDES[0]][0] + lm[FACE_SIDES[1]][0]) / 2;
    out.faceShare = faceW / w;
    out.offCenter = Math.abs(cx / w - 0.5);
    function px(x, y) { var i = ((y | 0) * w + (x | 0)) * 4; return [frame[i], frame[i + 1], frame[i + 2]]; }

    // Skin: four cheek patches
    var rad = faceW * 0.055, patches = [], skinTried = 0, skinClipped = 0, spreads = [];
    CHEEKS.forEach(function (idx) {
      var c = lm[idx], vals = [];
      for (var y = Math.max(0, c[1] - rad); y < Math.min(h, c[1] + rad); y++) {
        for (var x = Math.max(0, c[0] - rad); x < Math.min(w, c[0] + rad); x++) {
          if ((x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) > rad * rad) continue;
          var v = px(x, y);
          skinTried++;
          if (v[0] >= 250 || v[1] >= 250 || v[2] >= 250) { skinClipped++; continue; }
          var R = LIN[v[0]], G = LIN[v[1]], B = LIN[v[2]];
          if (R <= B) continue;
          vals.push([R, G, B, lum(R, G, B)]);
        }
      }
      if (vals.length < 20) { patches.push(null); return; }
      vals.sort(function (a, b) { return a[3] - b[3]; });
      spreads.push(vals[Math.floor(vals.length * 0.9)][3] / Math.max(1e-4, vals[Math.floor(vals.length * 0.1)][3]));
      var lo = Math.floor(vals.length * 0.25), hi = Math.ceil(vals.length * 0.75), s = [0, 0, 0], n = 0;
      for (var k = lo; k < hi; k++) { s[0] += vals[k][0]; s[1] += vals[k][1]; s[2] += vals[k][2]; n++; }
      patches.push([s[0] / n, s[1] / n, s[2] / n]);
    });
    out.skinClipped = skinTried ? skinClipped / skinTried : 0;
    out.skinSpread = spreads.length ? median(spreads) : 1;
    var good = patches.filter(Boolean);
    if (good.length >= 2) {
      out.skin = [0, 1, 2].map(function (c) { return median(good.map(function (q) { return q[c]; })); });
      var sideL = patches[0] || patches[2], sideR = patches[1] || patches[3];
      out.sideRatio = sideL && sideR ? Math.max(lum.apply(null, sideL), lum.apply(null, sideR)) / Math.max(1e-4, Math.min(lum.apply(null, sideL), lum.apply(null, sideR))) : 1;
    }

    // Looking straight ahead: each iris sits near the middle between the eye corners.
    out.gaze = [[33, 133, IRIS_L[0]], [362, 263, IRIS_R[0]]].map(function (t) {
      var a = lm[t[0]], b = lm[t[1]], c = lm[t[2]];
      return (c[0] - a[0]) / ((b[0] - a[0]) || 1);
    });

    // Eye whites and iris: inside each eye outline, read at full resolution when available.
    var es = hi ? hi.scale : 1, EW = hi ? Math.round(w * es) : w, EH = hi ? Math.round(h * es) : h;
    var skinLum = out.skin ? lum(out.skin[0], out.skin[1], out.skin[2]) : null;
    var white = [], clipped = 0, openness = [], irisL = [], irisRB = [], eyeBright = [], underEye = [];
    [[EYE_L, IRIS_L, 145], [EYE_R, IRIS_R, 374]].forEach(function (pair) {
      // Skin just under the eye (same shadow as the eye), compared with the cheek later.
      var eyeWpx = Math.abs(lm[pair[0][8]][0] - lm[pair[0][0]][0]) || faceW * 0.25;
      var ub = lm[pair[2]], ur = eyeWpx * 0.12, uvals = [];
      for (var uy = Math.max(0, ub[1] + eyeWpx * 0.28 - ur); uy < Math.min(h, ub[1] + eyeWpx * 0.28 + ur); uy++)
        for (var ux = Math.max(0, ub[0] - ur); ux < Math.min(w, ub[0] + ur); ux++) { var uv = px(ux, uy); if (uv[0] < 250) uvals.push(lum(LIN[uv[0]], LIN[uv[1]], LIN[uv[2]])); }
      if (uvals.length >= 10) underEye.push(median(uvals));
      var poly = pair[0].map(function (i) { return [lm[i][0] * es, lm[i][1] * es]; });
      var ic = [lm[pair[1][0]][0] * es, lm[pair[1][0]][1] * es], ir = 0;
      for (var k = 1; k < 5; k++) ir = Math.max(ir, Math.hypot(lm[pair[1][k]][0] * es - ic[0], lm[pair[1][k]][1] * es - ic[1]));
      var xs = poly.map(function (q) { return q[0]; }), ys = poly.map(function (q) { return q[1]; });
      var x0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), x1 = Math.min(EW - 1, Math.ceil(Math.max.apply(null, xs)));
      var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(EH - 1, Math.ceil(Math.max.apply(null, ys)));
      var eyeTop = Math.min.apply(null, ys), eyeH = Math.max.apply(null, ys) - eyeTop;
      openness.push(eyeH / Math.max(1, Math.max.apply(null, xs) - Math.min.apply(null, xs)));
      if (x1 <= x0 || y1 <= y0) return;
      var bw = x1 - x0 + 1, box = (hi ? hi.ctx : ctx).getImageData(x0, y0, bw, y1 - y0 + 1).data;
      var cand = [], iris = [], bright = [];
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
        if (!pointInPoly(x, y, poly)) continue;
        var d = Math.hypot(x - ic[0], y - ic[1]);
        var bi = ((y - y0) * bw + (x - x0)) * 4;
        var v = [box[bi], box[bi + 1], box[bi + 2]], mx = Math.max(v[0], v[1], v[2]);
        var L = lum(LIN[v[0]], LIN[v[1]], LIN[v[2]]), sat = mx ? (mx - Math.min(v[0], v[1], v[2])) / mx : 1;
        // Iris: the ring between the pupil and the iris edge (the pupil is a
        // black hole, the rim blends into lashes). Pupil leak, lash shadow and
        // highlights are dropped below by taking the middle of the range.
        if (d > ir * 0.4 && d < ir * 0.8) {
          // Only the sides of the ring, level with the pupil: lids and lashes
          // cover the top and bottom of the iris on hooded and narrow eyes.
          if (Math.abs(y - ic[1]) < ir * 0.45) iris.push([L, LIN[v[0]], LIN[v[2]]]);
          continue;
        }
        if (d < ir * 1.25) continue;
        bright.push(L);
        // Eye white candidates: the middle band of the eye only (the top and
        // bottom quarters are lash line and lid), and only low-color pixels.
        var rel = (y - eyeTop) / Math.max(1, eyeH);
        if (rel < 0.25 || rel > 0.75) continue;
        if (sat > 0.32) continue;
        cand.push([v[0], v[1], v[2], L]);
      }
      if (iris.length >= 8) {
        iris.sort(function (a, b) { return a[0] - b[0]; });
        var mid = iris.slice(Math.floor(iris.length * 0.35), Math.ceil(iris.length * 0.8));
        irisL.push(median(mid.map(function (q) { return q[0]; })));
        irisRB.push(median(mid.map(function (q) { return q[1] / Math.max(1e-4, q[2]); })));
      }
      if (bright.length >= 8) { bright.sort(function (a, b) { return b - a; }); eyeBright.push(bright[Math.floor(bright.length * 0.05)]); }
      // Real eye white is at least about as bright as the cheek (lids shade it
      // a little). Anything darker is lash, shadow or iris rim and is dropped,
      // which is the v3 failure: those dark pixels made the skin read light.
      var floor = skinLum != null ? skinLum * SETTINGS.scleraMinRatio : 0;
      var plain = cand.filter(function (q) { return q[3] >= floor; });
      plain.sort(function (a, b) { return b[3] - a[3]; });
      plain.slice(0, Math.ceil(plain.length * 0.6)).forEach(function (q) {
        if (q[0] >= 250 || q[1] >= 250 || q[2] >= 250) { clipped++; return; }
        white.push([LIN[q[0]], LIN[q[1]], LIN[q[2]]]);
      });
    });
    out.eyeOpen = Math.min.apply(null, openness);
    out.whiteCount = white.length + clipped;
    out.whiteClipped = out.whiteCount ? clipped / out.whiteCount : 0;
    out.whiteCount = Math.round(out.whiteCount / (es * es)); // in analysis-size pixels, so the limit is the same on every camera
    if (white.length >= 6) out.white = [0, 1, 2].map(function (c) { return median(white.map(function (q) { return q[c]; })); });
    if (irisL.length) {
      out.irisLum = median(irisL);
      out.irisWarm = median(irisRB) > 1.15; // brown iris (R well above B) vs blue/green/gray
    }
    // Brightest 5% of the eye region (any sliver of eye white, even on hooded
    // eyes) relative to the cheek: a lower bound on how deep the skin is.
    if (eyeBright.length && skinLum) out.eyeBrightRatio = Math.max.apply(null, eyeBright) / Math.max(1e-4, skinLum);
    // Under-eye skin vs cheek: well under 1 means the eyes sit in brow shadow,
    // which dims eye whites and iris alike and would make skin read lighter.
    if (underEye.length && skinLum) out.underEyeRatio = median(underEye) / Math.max(1e-4, skinLum);
    return out;
  }

  // Depth from the skin's own color balance, inside the range the iris (or a
  // clean eye-white reading) says we're in. Exposure-proof: ratios don't move
  // when the camera brightens or darkens the frame.
  function depthFromColor(skin, range) {
    var w = SETTINGS.colorFit[range] || SETTINGS.colorFit.mid, k = SETTINGS.colorContrast;
    var r = Math.max(1e-4, skin[0]), g = Math.max(1e-4, skin[1]), b = Math.max(1e-4, skin[2]);
    return Math.max(0, Math.min(100, w[0] + w[1] * k * Math.log(r / b) + w[2] * k * Math.log(g / b)));
  }

  // Combines frames, checks conditions, returns the skin's ITA.
  function combine(frames) {
    var withFace = frames.filter(function (f) { return f.face; });
    var frameMean = median(frames.map(function (f) { return f.frameMean; }));
    if (frameMean < 28) return { issue: "dark" };
    if (withFace.length < frames.length / 2) return { issue: "noFace" };
    var share = median(withFace.map(function (f) { return f.faceShare; }));
    var off = median(withFace.map(function (f) { return f.offCenter; }));
    if (share < 0.28) return { issue: "far" };
    if (off > 0.18) return { issue: "noFace" };
    var withSkin = withFace.filter(function (f) { return f.skin; });
    if (withSkin.length < withFace.length / 2) return { issue: "noFace" };
    // Skin washed out to pure white by the light hides real color, and hides shadowed-side differences too.
    if (median(withFace.map(function (f) { return f.skinClipped || 0; })) > 0.08) return { issue: "glare" };
    // Hard, direct light throws strong highlights and shadows across the cheeks
    // (soft window light measures about 2-3 here; direct sun 14+).
    if (median(withFace.map(function (f) { return f.skinSpread || 1; })) > 6) return { issue: "glare" };
    if (median(withSkin.map(function (f) { return f.sideRatio; })) > 1.6) return { issue: "uneven" };
    var open = median(withFace.map(function (f) { return f.eyeOpen; }));
    var count = median(withFace.map(function (f) { return f.whiteCount; }));
    var gaze = withFace.filter(function (f) { return f.gaze && f.gaze.every(function (g) { return g > 0.3 && g < 0.7; }); }).length;
    var withIris = withFace.filter(function (f) { return f.irisLum != null; });
    // Eyes closed (or covered): nothing to work with. Narrow or hooded eyes
    // with a visible iris go on; they just use the skin-color reading.
    if (open < SETTINGS.minEyeOpen && withIris.length < withFace.length / 2) return { issue: "eyes" };
    if (gaze < withFace.length / 2) return { issue: "gaze" };
    var withUnder = withFace.filter(function (f) { return f.underEyeRatio != null; });
    var underEye = withUnder.length ? median(withUnder.map(function (f) { return f.underEyeRatio; })) : null;
    // Eyes sitting in brow shadow dim the eye whites and iris together and make
    // every eye-based reading too light. Ask for light from the front instead.
    if (underEye != null && underEye < SETTINGS.minUnderEye) return { issue: "eyeShadow" };

    var skin = [0, 1, 2].map(function (c) { return median(withSkin.map(function (f) { return f.skin[c]; })); });
    var skinLum = lum(skin[0], skin[1], skin[2]);
    var clippedShare = median(withFace.map(function (f) { return f.whiteClipped; }));
    var withWhite = withFace.filter(function (f) { return f.white; });
    var eyesClipped = clippedShare > 0.3 && count >= SETTINGS.minWhitePixels;
    var haveWhite = !eyesClipped && count >= SETTINGS.minWhitePixels && withWhite.length >= withFace.length / 2;
    var irisRatio = withIris.length ? skinLum / Math.max(1e-4, median(withIris.map(function (f) { return f.irisLum; }))) : null;
    var irisWarm = withIris.length ? withIris.filter(function (f) { return f.irisWarm; }).length * 2 > withIris.length : null;
    var withBright = withFace.filter(function (f) { return f.eyeBrightRatio != null; });
    var eyeBright = withBright.length ? median(withBright.map(function (f) { return f.eyeBrightRatio; })) : null;
    // Nothing bright anywhere in the eye: eyes nearly shut or all lash. Ask, don't guess.
    if (eyeBright != null && eyeBright < SETTINGS.eyeBrightNone && !eyesClipped) return { issue: "eyes" };
    // Moderate brow shadow: the eye whites and iris sit in it, the cheek doesn't.
    var shadowFix = 1;
    if (underEye != null && underEye < SETTINGS.compensateUnderEye) shadowFix = 1 / underEye;
    if (irisRatio != null) irisRatio /= shadowFix;
    if (eyeBright != null) eyeBright *= shadowFix;

    // --- Reading A: skin compared with the eye whites (v3 method, strict pixels) ---
    var R = SETTINGS.scleraReflectance, white = null, wl = null, eyeDepth = null, rawEyeDepth = null, lab = null;
    if (haveWhite || eyesClipped) {
      white = eyesClipped ? [1, 1, 1] : [0, 1, 2].map(function (c) { return shadowFix * median(withWhite.map(function (f) { return f.white[c]; })); });
      wl = lum(white[0], white[1], white[2]);
      var k = SETTINGS.whiteBalanceFromEyes;
      var refl = [0, 1, 2].map(function (c) {
        var balance = Math.pow(wl / Math.max(1e-4, white[c]), k);
        return Math.min(1, skin[c] * balance * R / wl);
      });
      lab = labFromLinear(refl[0], refl[1], refl[2]);
      rawEyeDepth = lab[0];
      // v4: the stretch only deepens; it never pushes a reading lighter.
      eyeDepth = rawEyeDepth < SETTINGS.stretchAnchor
        ? SETTINGS.stretchAnchor + SETTINGS.contrastStretch * (rawEyeDepth - SETTINGS.stretchAnchor)
        : rawEyeDepth;
      eyeDepth = Math.max(0, Math.min(100, eyeDepth));
    }

    // --- Reading B: the skin's own color, in the range the iris (or a trusted eye reading) sets ---
    // Color balance from the eye whites when we have them; otherwise the camera's own.
    var wbSkin = skin;
    if (white && !eyesClipped) {
      var kk = SETTINGS.whiteBalanceFromEyes;
      wbSkin = [0, 1, 2].map(function (c) { return skin[c] * Math.pow(wl / Math.max(1e-4, white[c]), kk); });
    }
    // Which range? Deep cues are checked first, because deep skin shown light is
    // the failure we must never repeat. Any one deep cue is enough.
    var range = "mid";
    var deepCue = (eyeBright != null && eyeBright >= SETTINGS.eyeBrightDeep) ||
                  (irisRatio != null && irisWarm && irisRatio <= SETTINGS.irisDeep) ||
                  (eyeDepth != null && eyeDepth < 41); // a deep eye reading is trustworthy (see below)
    var lightCue = (irisWarm === false) ||
                   (irisRatio != null && irisRatio >= SETTINGS.irisLight) ||
                   (eyeBright != null && eyeBright <= SETTINGS.eyeBrightLight);
    if (deepCue) range = "deep"; else if (lightCue) range = "light";
    var colorDepth = depthFromColor(wbSkin, range);

    // --- Fusion ---
    // Contaminated eye whites (lash, lid, iris rim) are always DARKER than real
    // ones, which makes skin read LIGHTER. So an eye reading that says deep is
    // believed; one that says light must agree with the skin-color reading.
    // How much to trust the eye reading: eye whites well brighter than the
    // cheek and plenty of them = clean; barely brighter = pigmented or lid-shaded.
    var scleraRatio = wl != null ? wl / Math.max(1e-4, skinLum) : null;
    var q = scleraRatio == null ? 0 : Math.max(0, Math.min(1, (scleraRatio - 1.0) / 1.0)) * Math.min(1, count / 60);
    var wEye = 0.4 + 0.5 * q, diff = eyeDepth == null ? 0 : Math.abs(eyeDepth - colorDepth);
    var depth, source = "eyes", between = false, deeperThan = false;
    if (eyesClipped) {
      // Eye whites brighter than the camera can record: skin is at least this deep.
      depth = Math.max(eyeDepth, colorDepth); source = "eyes"; deeperThan = true;
    } else if (eyeDepth == null) {
      depth = colorDepth; source = "skin"; between = true;
    } else if (range === "deep" && eyeDepth > colorDepth + SETTINGS.disagreeDepth / 2) {
      // Confidently deep skin, yet the eye whites say lighter: that is what
      // pigmented eye whites do (most Black adults have them), so the skin's
      // color leads and the eye reading only nudges.
      depth = 0.3 * eyeDepth + 0.7 * colorDepth; between = true;
    } else if (eyeDepth < 48) {
      // A deep eye reading is trusted (contamination only lightens).
      depth = diff <= SETTINGS.disagreeDepth ? wEye * eyeDepth + (1 - wEye) * colorDepth : eyeDepth;
      between = diff > SETTINGS.disagreeDepth / 2;
    } else if (colorDepth < eyeDepth - SETTINGS.disagreeDepth) {
      // Eyes say light, skin says much deeper: the eye reading is contaminated.
      depth = colorDepth; source = "skin"; between = true;
    } else {
      depth = wEye * eyeDepth + (1 - wEye) * colorDepth;
      between = diff > SETTINGS.disagreeDepth / 2;
    }
    // Hard limits from the iris range. Skin about as bright as the iris is deep
    // skin, whatever the eye whites said; this is what makes Pearl impossible
    // for a deep-skinned face.
    if (range === "deep" && depth > SETTINGS.deepCeiling) { depth = SETTINGS.deepCeiling; source = "skin"; between = true; }
    if (range === "light" && depth < SETTINGS.lightFloor) { depth = SETTINGS.lightFloor; between = true; }
    depth = Math.max(0, Math.min(100, depth));
    var outLab = lab || labFromLinear(Math.min(1, wbSkin[0]), Math.min(1, wbSkin[1]), Math.min(1, wbSkin[2]));
    outLab = [depth, outLab[1], outLab[2]];
    return {
      issue: null, depth: depth, between: between, source: source, deeperThan: deeperThan,
      eyeDepth: eyeDepth, rawDepth: rawEyeDepth, colorDepth: colorDepth, range: range, irisRatio: irisRatio, irisWarm: irisWarm,
      eyeBright: eyeBright, underEye: underEye, whiteCount: count, scleraRatio: scleraRatio, eyeWeight: eyeDepth == null ? 0 : wEye,
      ita: ita(outLab), lab: outLab
    };
  }

  // Depth -> gemstone (0 = Pearl ... 9 = Onyx), plus the nearer neighbor as runner-up.
  function classify(depth, deeperThan, forceBetween) {
    var best = GEMSTONES - 1;
    for (var i = 0; i < EDGES.length; i++) if (depth >= EDGES[i]) { best = i; break; }
    if (deeperThan) {
      // The eye whites were too bright to read, so the skin is at least this deep.
      var deeper = Math.min(GEMSTONES - 1, best + 1);
      return { best: deeper, alt: deeper === best ? best - 1 : best, between: true, depth: depth };
    }
    var top = best > 0 ? EDGES[best - 1] : Infinity, bottom = best < EDGES.length ? EDGES[best] : -Infinity;
    var toLighter = top - depth, toDeeper = depth - bottom;
    var alt = toLighter < toDeeper ? best - 1 : best + 1;
    if (alt < 0) alt = 1; if (alt > GEMSTONES - 1) alt = GEMSTONES - 2;
    return { best: best, alt: alt, between: !!forceBetween || Math.min(toLighter, toDeeper) < SETTINGS.betweenMargin, depth: depth };
  }

  var MESSAGES = {
    loading: "Getting things ready…",
    dark: "It's too dark. Face a window or a bright lamp.",
    noFace: "Center your face in the oval.",
    far: "Bring your phone a little closer.",
    eyes: "Open your eyes wide. Take off glasses, sunglasses or a hat, and move hair away from your eyes.",
    gaze: "Look straight into the camera, not at the screen.",
    glare: "The light is too strong on your face. Step out of direct sun, or turn so the light is soft and in front of you.",
    eyeShadow: "Your eyes are in shadow. Face the light straight on instead of having it overhead.",
    uneven: "One side of your face is in shadow. Turn so the light hits you straight on.",
    ok: "Perfect. Hold still…"
  };

  // ---------- Face mesh loader ----------
  var meshPromise = null;
  function loadMesh() {
    if (meshPromise) return meshPromise;
    meshPromise = new Promise(function (resolve, reject) {
      function make() {
        try {
          var fm = new window.FaceMesh({ locateFile: function (f) { return BASE + "vendor/face_mesh/" + f; } });
          fm.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5, selfieMode: false });
          var pending = null;
          fm.onResults(function (r) { if (pending) { var p = pending; pending = null; p(r); } });
          var api = {
            detect: function (source) {
              return new Promise(function (res, rej) {
                pending = res;
                fm.send({ image: source }).catch(function (e) { pending = null; rej(e); });
              });
            }
          };
          fm.initialize().then(function () { resolve(api); }, reject);
        } catch (e) { reject(e); }
      }
      if (window.FaceMesh) return make();
      var s = document.createElement("script");
      s.src = BASE + "vendor/face_mesh/face_mesh.js";
      s.crossOrigin = "anonymous";
      s.onload = make;
      s.onerror = function () { reject(new Error("load")); };
      document.head.appendChild(s);
    });
    meshPromise.catch(function () { meshPromise = null; });
    return meshPromise;
  }

  // ---------- Styles ----------
  var CSS = "" +
    ".sf-open{font:inherit;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;margin:2px 0 4px;padding:9px 14px;border-radius:999px;border:1px solid var(--espresso,#261000);background:transparent;color:var(--espresso,#261000);cursor:pointer;justify-self:start}" +
    ".sf-open[hidden]{display:none}" +
    ".sf-open:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-open svg{width:16px;height:16px;flex:none}" +
    ".sf-picked{font-size:12px;color:var(--espresso-soft,#5B4436);margin:0}" +
    ".sf-picked:empty{display:none}" +
    "dialog.sf{border:0;padding:0;width:min(440px,100vw);max-width:100vw;max-height:100dvh;border-radius:20px;background:var(--warm-white,#FFFBF7);color:var(--espresso,#261000);font-family:var(--body,Raleway,Arial,sans-serif);box-shadow:0 30px 80px -20px rgba(38,16,0,.6)}" +
    "dialog.sf::backdrop{background:rgba(38,16,0,.6)}" +
    "@media (max-width:480px){dialog.sf{width:100vw;height:100dvh;max-height:100dvh;border-radius:0;margin:0}}" +
    ".sf-body{padding:22px 22px 24px;display:grid;gap:14px}" +
    ".sf-step{display:grid;gap:14px}" +
    ".sf-head{display:flex;justify-content:space-between;align-items:center;gap:12px}" +
    ".sf h2{font-family:var(--display,Georgia,serif);font-weight:400;font-size:26px;line-height:1.15;margin:0}" +
    ".sf-x{font:inherit;font-size:24px;line-height:1;border:0;background:transparent;color:var(--espresso,#261000);cursor:pointer;width:40px;height:40px;border-radius:50%;flex:none}" +
    ".sf-x:hover{background:var(--paper,#FFF3E8)}" +
    ".sf p{margin:0;font-size:14px;color:var(--espresso-soft,#5B4436)}" +
    ".sf ul{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:14px}" +
    ".sf li{display:flex;gap:10px;align-items:flex-start}" +
    ".sf li b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--paper,#FFF3E8);color:var(--auburn,#96262C);font-size:12px;display:grid;place-items:center;margin-top:1px}" +
    ".sf-consent{display:flex;gap:10px;align-items:flex-start;background:var(--paper,#FFF3E8);border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.45;color:var(--espresso,#261000);cursor:pointer}" +
    ".sf-consent input{margin-top:2px;accent-color:var(--auburn,#96262C);width:18px;height:18px;flex:none}" +
    ".sf-btn{font:inherit;font-weight:700;font-size:15px;letter-spacing:.03em;border:0;border-radius:999px;padding:14px 20px;cursor:pointer;background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7);width:100%}" +
    ".sf-btn:hover{background:var(--auburn,#96262C)}" +
    ".sf-btn[disabled]{opacity:.5;cursor:default}" +
    ".sf-btn[disabled]:hover{background:var(--espresso,#261000)}" +
    ".sf-btn.ghost{background:transparent;color:var(--espresso,#261000);border:1px solid var(--espresso,#261000)}" +
    ".sf-btn.ghost:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    ".sf-view{position:relative;width:100%;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#1a0b00}" +
    ".sf-view video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}" +
    ".sf-view svg{position:absolute;inset:0;width:100%;height:100%}" +
    ".sf-status{position:absolute;left:12px;right:12px;bottom:12px;background:rgba(38,16,0,.8);color:#FFFBF7;font-size:14px;line-height:1.4;padding:11px 12px;border-radius:12px;text-align:center}" +
    ".sf-status.ok{box-shadow:inset 0 0 0 1.5px var(--gold,#E4A524)}" +
    ".sf-result{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;background:var(--paper,#FFF3E8);border-radius:16px;padding:16px}" +
    ".sf-result i{width:64px;height:64px;border-radius:50%;display:block;border:3px solid var(--warm-white,#FFFBF7);box-shadow:0 0 0 1px rgba(38,16,0,.12)}" +
    ".sf-result small{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--burnt-orange,#AB5B1E)}" +
    ".sf-result strong{display:block;font-family:var(--display,Georgia,serif);font-weight:400;font-size:28px;line-height:1.1;color:var(--espresso,#261000)}" +
    ".sf-alt{display:flex;align-items:center;gap:10px;font-size:14px}" +
    ".sf-alt i{width:24px;height:24px;border-radius:50%;display:block;border:1px solid rgba(38,16,0,.15);flex:none}" +
    ".sf-alt button{font:inherit;font-weight:600;font-size:14px;color:var(--auburn,#96262C);background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}" +
    ".sf-debug{font:12px/1.4 ui-monospace,Menlo,monospace;background:#261000;color:#FFFBF7;border-radius:10px;padding:10px;margin:0;white-space:pre-wrap}" +
    ".sf [hidden]{display:none !important}";

  var ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function setup(trigger) {
    var groupName = trigger.getAttribute("data-shade-finder");
    var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + groupName + '"]'));
    var shades = radios.filter(function (r) { return r.value !== "prefer_not"; }).map(function (r) {
      var label = r.closest("label"), sw = label && label.querySelector("i");
      var cs = sw ? getComputedStyle(sw) : null;
      return { input: r, name: label ? label.textContent.trim() : r.value, color: cs ? (cs.getPropertyValue("--c").trim() || cs.backgroundColor) : "#ccc" };
    });
    if (shades.length !== GEMSTONES) return;

    var canUseCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false && typeof WebAssembly === "object";
    trigger.hidden = false;
    var picked = document.getElementById(trigger.getAttribute("aria-describedby") || "") || null;

    var dlg = el("dialog", { "class": "sf", "aria-labelledby": "sfTitle" });
    dlg.innerHTML =
      '<div class="sf-body">' +
        '<div class="sf-head"><h2 id="sfTitle">Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +

        '<div data-step="intro" class="sf-step">' +
          '<p>Your camera finds your shade in a few seconds. Then you pick your undertone.</p>' +
          '<ul>' +
            '<li><b>1</b><span>Face a window in daylight, out of direct sun, so your whole face is evenly lit.</span></li>' +
            '<li><b>2</b><span>Take off glasses, sunglasses, hats and anything near your eyes, and move hair off your face.</span></li>' +
            '<li><b>3</b><span>Open your eyes wide and look straight into the camera, not at the screen.</span></li>' +
            '<li><b>4</b><span>Hold still. Your shade shows up on its own.</span></li>' +
          '</ul>' +
          '<label class="sf-consent"><input type="checkbox" data-consent><span>I agree to let Pulse map my face on this device to find my shade. The image and face measurements stay on my phone and are never saved or sent.</span></label>' +
          '<button type="button" class="sf-btn" data-start disabled>Start Camera</button>' +
        '</div>' +

        '<div data-step="camera" hidden class="sf-step">' +
          '<div class="sf-view">' +
            '<video playsinline muted autoplay></video>' +
            '<svg viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">' +
              '<defs><mask id="sfMask"><rect width="300" height="400" fill="#fff"/><ellipse cx="150" cy="180" rx="100" ry="135" fill="#000"/></mask></defs>' +
              '<rect width="300" height="400" fill="rgba(38,16,0,.45)" mask="url(#sfMask)"/>' +
              '<ellipse cx="150" cy="180" rx="100" ry="135" fill="none" stroke="#FFFBF7" stroke-width="2" stroke-dasharray="6 6"/>' +
            '</svg>' +
            '<div class="sf-status" role="status" aria-live="polite"></div>' +
          '</div>' +
          '<button type="button" class="sf-btn" data-capture disabled>Get My Shade</button>' +
        '</div>' +

        '<div data-step="result" hidden class="sf-step">' +
          '<div class="sf-result"><i data-best-dot></i><div><small>Your Shade</small><strong data-best-name></strong></div></div>' +
          '<p data-note></p>' +
          '<pre class="sf-debug" data-debug hidden></pre>' +
          '<button type="button" class="sf-btn ghost" data-copy-reading hidden>Copy Reading for the Panel Sheet</button>' +
          '<div class="sf-alt"><i data-alt-dot></i><span>Also close: <button type="button" data-use-alt></button></span></div>' +
          '<button type="button" class="sf-btn" data-use-best></button>' +
          '<div class="sf-row"><button type="button" class="sf-btn ghost" data-retry>Try Again</button><button type="button" class="sf-btn ghost" data-close>Pick Myself</button></div>' +
        '</div>' +

        '<div data-step="error" hidden class="sf-step">' +
          '<p data-error></p>' +
          '<p>To pick by eye: in daylight, hold your phone up to a mirror next to your jawline and choose the shade that blends in best.</p>' +
          '<button type="button" class="sf-btn" data-close>Pick Myself</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    var q = function (s) { return dlg.querySelector(s); };
    var video = q("video"), status = q(".sf-status"), captureBtn = q("[data-capture]"), startBtn = q("[data-start]"), consent = q("[data-consent]");
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var hiCanvas = document.createElement("canvas");
    var hiCtx = hiCanvas.getContext("2d", { willReadFrequently: true });
    var stream = null, mesh = null, liveTimer = null, busy = false, result = null, focusAfter = null, goodChecks = 0, session = 0, handedOff = false, holdIssue = null, holdUntil = 0, needChecks = SETTINGS.goodChecksBeforeAuto, recent = [];

    consent.addEventListener("change", function () { startBtn.disabled = !consent.checked; });

    function show(step) {
      ["intro", "camera", "result", "error"].forEach(function (s) { q('[data-step="' + s + '"]').hidden = s !== step; });
    }
    function stopCamera() {
      session++;
      clearTimeout(liveTimer); liveTimer = null; busy = false;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null; video.srcObject = null;
    }
    function setStatus(key) {
      status.textContent = MESSAGES[key || "ok"];
      status.classList.toggle("ok", !key);
    }
    // What to show for the last few frames (null = good): "Perfect" only when most frames were good; otherwise the
    // most frequent problem (ties go to the most recent).
    function mostCommon(list) {
      var good = list.filter(function (x) { return !x; }).length;
      if (good * 2 > list.length) return null;
      var best = null, bestN = 0;
      for (var i = list.length - 1; i >= 0; i--) {
        if (!list[i]) continue;
        var n = 0; for (var j = 0; j < list.length; j++) if (list[j] === list[i]) n++;
        if (n > bestN) { bestN = n; best = list[i]; }
      }
      return best;
    }
    function fail(msg) { q("[data-error]").textContent = msg; show("error"); }

    // Grabs the current frame and finds the face. Resolves to a frame reading.
    function readFrame() {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || !mesh) return Promise.resolve(null);
      var sc = Math.min(1, SETTINGS.analysisWidth / vw), w = Math.round(vw * sc), h = Math.round(vh * sc);
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      // Same frame at full camera resolution, for the eye whites
      if (hiCanvas.width !== vw) { hiCanvas.width = vw; hiCanvas.height = vh; }
      hiCtx.drawImage(video, 0, 0, vw, vh);
      return mesh.detect(canvas).then(function (r) {
        var f = r && r.multiFaceLandmarks && r.multiFaceLandmarks[0];
        var lm = f && f.length >= 478 ? f.map(function (p) { return [p.x * w, p.y * h]; }) : null;
        return analyzeFrame(ctx, w, h, lm, { ctx: hiCtx, scale: vw / w });
      });
    }

    function loop(my) {
      if (my !== session || !stream) return;
      if (busy) { liveTimer = setTimeout(function () { loop(my); }, 300); return; }
      readFrame().then(function (fr) {
        if (my !== session || busy) return;
        if (fr) {
          var res = combine([fr]);
          // Frames in borderline light can flip between passing and failing. The message shows the most common
          // verdict of the last few frames (no flicker), and a reading starts after two good frames in a row or
          // three of the last four; the 8-frame reading then gives a result or a refusal that stays up for a moment.
          recent.push(res.issue || null); if (recent.length > 4) recent.shift();
          var holding = holdIssue && Date.now() < holdUntil;
          var good = recent.filter(function (x) { return !x; }).length;
          var twoInRow = recent.length >= 2 && !recent[recent.length - 1] && !recent[recent.length - 2];
          setStatus(holding && !res.issue ? holdIssue : mostCommon(recent));
          if (!holding && (good >= 3 || (twoInRow && needChecks <= SETTINGS.goodChecksBeforeAuto))) { capture(); return; }
        }
        liveTimer = setTimeout(function () { loop(my); }, 350);
      }, function () { liveTimer = setTimeout(function () { loop(my); }, 600); });
    }

    function startCamera() {
      show("camera");
      setStatus("loading"); status.classList.remove("ok");
      captureBtn.disabled = true; goodChecks = 0;
      holdIssue = null; holdUntil = 0; needChecks = SETTINGS.goodChecksBeforeAuto; recent = [];
      var my = ++session;
      var cam = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } } });
      Promise.all([cam, loadMesh().catch(function () { return null; })]).then(function (arr) {
        if (my !== session) { arr[0].getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = arr[0]; mesh = arr[1];
        if (!mesh) { stopCamera(); fail(CONFIG.loadFailedMessage || "Find My Shade couldn't load on this browser. Try updating your browser, or pick your shade below."); return; }
        video.srcObject = stream;
        var pl = video.play(); if (pl && pl.catch) pl.catch(function () {});
        function ready() { captureBtn.disabled = false; setStatus("noFace"); setTimeout(function () { loop(my); }, 700); }
        if (video.readyState >= 1) ready(); else video.onloadedmetadata = ready;
      }).catch(function (e) {
        if (my !== session) return;
        var inApp = /Instagram|FBAN|FBAV|TikTok|Snapchat|Line\//i.test(navigator.userAgent);
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
          fail(CONFIG.blockedMessage || (inApp
            ? "This app's built-in browser blocked the camera. Tap the menu (•••), choose Open in Browser, then try again."
            : "Camera access was blocked. To use Find My Shade, allow camera access for this site in your browser settings and try again."));
        } else if (e && e.name === "NotFoundError") fail("We couldn't find a camera on this device.");
        else fail("The camera didn't start. Close other apps that might be using it and try again.");
      });
    }

    function capture() {
      if (busy || !stream) return;
      busy = true; captureBtn.disabled = true; goodChecks = 0; recent = [];
      setStatus(null);
      var my = session, frames = [];
      (function next() {
        if (my !== session) return;
        readFrame().then(function (fr) {
          if (my !== session) return;
          if (fr) frames.push(fr);
          if (frames.length < SETTINGS.framesPerReading) { setTimeout(next, 60); return; }
          busy = false; captureBtn.disabled = false;
          var res = combine(frames);
          if (res.issue) {
            holdIssue = res.issue; holdUntil = Date.now() + SETTINGS.holdIssueMs;
            needChecks = SETTINGS.goodChecksBeforeAuto + 2;
            setStatus(res.issue); loop(my); return;
          }
          result = classify(res.depth, res.deeperThan, res.between);
          result.reading = res;
          stopCamera();
          showResult();
        }, function () { busy = false; captureBtn.disabled = false; loop(my); });
      })();
    }

    function showResult() {
      // A page can take the reading itself (the Pulse app's built-in finder page does this): it listens for
      // "pulseshadefinder:result" on the trigger and calls preventDefault() to skip the result screen.
      var handoff = new CustomEvent("pulseshadefinder:result", { cancelable: true, detail: {
        gemstone: result.best + 1, alt: result.alt + 1, close: !!result.between, depth: result.depth,
        source: result.reading ? result.reading.source : null,
        lab: result.reading ? [result.depth, result.reading.lab[1], result.reading.lab[2]] : null
      } });
      if (!trigger.dispatchEvent(handoff)) { handedOff = true; close(); return; }
      var best = shades[result.best], alt = shades[result.alt];
      q("[data-best-dot]").style.background = best.color;
      q("[data-best-name]").textContent = best.name;
      q("[data-use-best]").textContent = "Use " + best.name;
      var rd = result.reading;
      q("[data-note]").textContent = rd && rd.source === "skin"
        ? "We matched this from your skin's color. You're between " + best.name + " and " + alt.name + ". Go with whichever looks more like you in daylight."
        : result.between
          ? "You're right between " + best.name + " and " + alt.name + ". Go with whichever feels more like you."
          : "If another shade feels more like you, pick that one instead.";
      q("[data-alt-dot]").style.background = alt.color;
      var dbg = q("[data-debug]"), copyBtn = q("[data-copy-reading]");
      dbg.hidden = !(DEBUG && rd);
      copyBtn.hidden = !(CAL && rd);
      if (CAL && rd) {
        // One line, tab-separated, in the panel sheet's column order. Numbers only.
        var cols = ["v" + (window.PulseShadeFinder && window.PulseShadeFinder.VERSION || "4"), new Date().toISOString().slice(0, 16), navigator.userAgent.replace(/\s+/g, " ").slice(0, 60),
          best.name, alt.name, rd.source, rd.depth.toFixed(1), rd.eyeDepth == null ? "" : rd.eyeDepth.toFixed(1), rd.rawDepth == null ? "" : rd.rawDepth.toFixed(1), rd.colorDepth.toFixed(1), rd.range,
          rd.irisRatio == null ? "" : rd.irisRatio.toFixed(2), rd.irisWarm == null ? "" : (rd.irisWarm ? "brown" : "light"), rd.eyeBright == null ? "" : rd.eyeBright.toFixed(2), rd.underEye == null ? "" : rd.underEye.toFixed(2),
          rd.whiteCount == null ? "" : Math.round(rd.whiteCount), rd.scleraRatio == null ? "" : rd.scleraRatio.toFixed(2), rd.eyeWeight == null ? "" : rd.eyeWeight.toFixed(2),
          rd.lab.map(function (x) { return x.toFixed(1); }).join(" ")];
        copyBtn.onclick = function () {
          var text = cols.join("\t");
          var done = function () { copyBtn.textContent = "Copied. Paste it in the sheet, then add the shade you wear."; };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy this line:", text); });
          else window.prompt("Copy this line:", text);
        };
      }
      if (DEBUG && rd) {
        var f1 = function (x) { return x == null ? "n/a" : (+x).toFixed(1); };
        dbg.textContent = "depth " + f1(rd.depth) + " from " + rd.source + (rd.deeperThan ? " (eyes blown out, at least this deep)" : "") +
          "\neye reading " + f1(rd.eyeDepth) + " (raw " + f1(rd.rawDepth) + "), white px " + f1(rd.whiteCount) + ", white/skin " + (rd.scleraRatio == null ? "n/a" : rd.scleraRatio.toFixed(2)) +
          "\nskin-color reading " + f1(rd.colorDepth) + " in " + rd.range + " range, skin/iris " + (rd.irisRatio == null ? "n/a" : rd.irisRatio.toFixed(2)) +
          "\nLab " + rd.lab.map(function (x) { return x.toFixed(1); }).join(", ") +
          "\nsettings: sclera " + SETTINGS.scleraReflectance + ", stretch " + SETTINGS.contrastStretch + " below " + SETTINGS.stretchAnchor + ", iris deep<=" + SETTINGS.irisDeep + " light>=" + SETTINGS.irisLight;
      }
      q("[data-use-alt]").textContent = alt.name;
      show("result");
      q("[data-use-best]").focus();
    }

    function choose(shade) {
      shade.input.checked = true;
      shade.input.dispatchEvent(new Event("change", { bubbles: true }));
      if (picked) picked.textContent = "Suggested by Find My Shade: " + shade.name + ". Now pick your undertone below. You can change either anytime.";
      focusAfter = shade.input;
      close();
    }

    function open() {
      result = null; handedOff = false;
      if (!canUseCamera) {
        fail(CONFIG.unsupportedMessage || (window.isSecureContext === false ? "The camera only works on the secure (https) version of this page." : "This browser can't use the camera. Try Safari or Chrome."));
      } else {
        show("intro");
        loadMesh().catch(function () {}); // start downloading while they read
      }
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
      document.documentElement.style.overflow = "hidden";
    }
    function close() {
      stopCamera();
      if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
    }

    dlg.addEventListener("close", function () {
      stopCamera();
      document.documentElement.style.overflow = "";
      trigger.dispatchEvent(new CustomEvent("pulseshadefinder:close", { detail: { handedOff: handedOff, picked: !!focusAfter } }));
      var target = focusAfter || trigger; focusAfter = null;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
      var lbl = target.closest && target.closest("label");
      if (lbl && lbl.scrollIntoView) lbl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) { close(); return; }
      var t = e.target.closest("button"); if (!t) return;
      if (t.hasAttribute("data-close")) close();
      else if (t.hasAttribute("data-start") || t.hasAttribute("data-retry")) startCamera();
      else if (t.hasAttribute("data-capture")) capture();
      else if (t.hasAttribute("data-use-best")) choose(shades[result.best]);
      else if (t.hasAttribute("data-use-alt")) choose(shades[result.alt]);
    });
    document.addEventListener("visibilitychange", function () { if (document.hidden && stream) close(); });
    trigger.addEventListener("click", open);
    radios.forEach(function (r) { r.addEventListener("change", function (e) { if (e.isTrusted && picked) picked.textContent = ""; }); });
  }

  function init() {
    if (!document.getElementById("sf-style")) {
      var st = el("style", { id: "sf-style" }); st.textContent = CSS; document.head.appendChild(st);
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-shade-finder]"), function (b) {
      if (!b.querySelector("svg")) b.insertAdjacentHTML("afterbegin", ICON_CAM);
      setup(b);
    });
  }

  window.PulseShadeFinder = { VERSION: "4.0", EDGES: EDGES, analyzeFrame: analyzeFrame, combine: combine, classify: classify, depthFromColor: depthFromColor, loadMesh: loadMesh, SETTINGS: SETTINGS, labFromLinear: labFromLinear, ita: ita };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
