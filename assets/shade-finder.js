/*
 * Pulse "Find My Shade" camera helper (v3: eye-white reference, nothing to hold).
 *
 * Why the eyes: phone cameras brighten or darken every face so it looks
 * "normal", which made v1 give most people the same middle shade. The whites
 * of the eyes are in the same light as the skin and go through the same
 * camera adjustments, and they're close to white on everyone. Comparing
 * cheek skin with the eye whites cancels out the camera's brightness changes.
 *
 * The comparison becomes an Individual Typology Angle (ITA), the standard
 * skin-colorimetry measure used in dermatology research.
 *
 * Shade baseline: the 36 shades of Pat McGrath Labs Skin Fetish: Sublime
 * Perfection Foundation (REFERENCE below). Each of Pulse's ten gemstone
 * shades is defined as a run of those shades, lightest to deepest. The
 * reading is matched to the nearest of the 36 and reported as its gemstone.
 * Colors were sampled from the brand's official smear swatch photos on
 * patmcgrath.com (Oct 2026); undertones are the brand's own descriptions.
 * Pulse isn't affiliated with Pat McGrath Labs.
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
    // Deep 24. Lower it if results run too light; raise it if too deep.
    scleraReflectance: 0.30,
    // How much to trust the eye whites for color balance (0 = trust the
    // camera's own white balance, 1 = treat eye whites as pure white).
    // Eye whites are often slightly yellow, so this stays partial.
    whiteBalanceFromEyes: 0.75,
    // Within this many ITA degrees of the nearest shade in a neighboring
    // gemstone, the result says it's between the two.
    betweenMargin: 3,
    framesPerReading: 8,
    goodChecksBeforeAuto: 2,
    analysisWidth: 720
  };

  // Pat McGrath Skin Fetish shades -> Pulse gemstone (0 = Pearl ... 9 = Onyx).
  // [number, name, undertone, swatch hex, gemstone]
  var REFERENCE = [
    [1, "Light 1", "pink", "#f8e1d4", 0], [2, "Light 2", "neutral yellow", "#f6dcca", 0], [3, "Light 3", "yellow", "#edd8be", 0],
    [4, "Light 4", "peach", "#f6d2b9", 1], [5, "Light 5", "yellow neutral", "#e8c5a7", 1], [6, "Light 6", "pink neutral", "#efc8ae", 1], [7, "Light 7", "yellow peach", "#ecccaf", 1],
    [8, "Light Medium 8", "peach", "#f0c5a4", 2], [9, "Light Medium 9", "pink neutral", "#e8baa1", 2], [10, "Light Medium 10", "peach neutral", "#e6b997", 2],
    [11, "Light Medium 11", "peach", "#e7b592", 3], [12, "Light Medium 12", "peach", "#ebb28f", 3], [13, "Light Medium 13", "yellow neutral", "#e4b388", 3],
    [14, "Light Medium 14", "neutral olive", "#d3a275", 4], [15, "Medium 15", "golden neutral", "#ca9e70", 4], [16, "Medium 16", "peach", "#d09f69", 4], [17, "Medium 17", "neutral peach", "#c88c5a", 4],
    [18, "Medium 18", "neutral olive", "#b1845a", 5], [19, "Medium 19", "golden", "#b47749", 5], [20, "Medium 20", "golden red", "#b4724a", 5], [21, "Medium 21", "neutral olive", "#a67341", 5],
    [22, "Medium Deep 22", "neutral red", "#a36945", 6], [23, "Medium Deep 23", "golden olive", "#a46e3a", 6], [24, "Medium Deep 24", "golden neutral", "#a56436", 6], [25, "Medium Deep 25", "neutral red", "#a15a31", 6],
    [26, "Medium Deep 26", "olive", "#9a5b27", 7], [27, "Medium Deep 27", "golden red", "#945e36", 7], [28, "Medium Deep 28", "red", "#965b39", 7], [29, "Deep 29", "golden", "#885737", 7], [30, "Deep 30", "neutral olive", "#905b3c", 7],
    [31, "Deep 31", "neutral red", "#89512f", 8], [32, "Deep 32", "neutral golden", "#7e4527", 8], [33, "Deep 33", "neutral red", "#773f23", 8],
    [34, "Deep 34", "neutral olive", "#5c3421", 9], [35, "Deep 35", "red neutral", "#4f2719", 9], [36, "Deep 36", "neutral", "#492d1e", 9]
  ];
  var GEMSTONES = 10;

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
  function analyzeFrame(ctx, w, h, lm) {
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
    var rad = faceW * 0.055, patches = [];
    CHEEKS.forEach(function (idx) {
      var c = lm[idx], vals = [];
      for (var y = Math.max(0, c[1] - rad); y < Math.min(h, c[1] + rad); y++) {
        for (var x = Math.max(0, c[0] - rad); x < Math.min(w, c[0] + rad); x++) {
          if ((x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) > rad * rad) continue;
          var v = px(x, y);
          if (v[0] >= 250 || v[1] >= 250 || v[2] >= 250) continue;
          var R = LIN[v[0]], G = LIN[v[1]], B = LIN[v[2]];
          if (R <= B) continue;
          vals.push([R, G, B, lum(R, G, B)]);
        }
      }
      if (vals.length < 20) { patches.push(null); return; }
      vals.sort(function (a, b) { return a[3] - b[3]; });
      var lo = Math.floor(vals.length * 0.25), hi = Math.ceil(vals.length * 0.75), s = [0, 0, 0], n = 0;
      for (var k = lo; k < hi; k++) { s[0] += vals[k][0]; s[1] += vals[k][1]; s[2] += vals[k][2]; n++; }
      patches.push([s[0] / n, s[1] / n, s[2] / n]);
    });
    var good = patches.filter(Boolean);
    if (good.length >= 2) {
      out.skin = [0, 1, 2].map(function (c) { return median(good.map(function (q) { return q[c]; })); });
      var sideL = patches[0] || patches[2], sideR = patches[1] || patches[3];
      out.sideRatio = sideL && sideR ? Math.max(lum.apply(null, sideL), lum.apply(null, sideR)) / Math.max(1e-4, Math.min(lum.apply(null, sideL), lum.apply(null, sideR))) : 1;
    }

    // Eye whites: inside each eye outline, outside the iris
    var white = [], clipped = 0, openness = [];
    [[EYE_L, IRIS_L], [EYE_R, IRIS_R]].forEach(function (pair) {
      var poly = pair[0].map(function (i) { return lm[i]; });
      var ic = lm[pair[1][0]], ir = 0;
      for (var k = 1; k < 5; k++) ir = Math.max(ir, Math.hypot(lm[pair[1][k]][0] - ic[0], lm[pair[1][k]][1] - ic[1]));
      ir *= 1.15;
      var xs = poly.map(function (q) { return q[0]; }), ys = poly.map(function (q) { return q[1]; });
      var x0 = Math.max(0, Math.min.apply(null, xs)), x1 = Math.min(w - 1, Math.max.apply(null, xs));
      var y0 = Math.max(0, Math.min.apply(null, ys)), y1 = Math.min(h - 1, Math.max.apply(null, ys));
      openness.push((y1 - y0) / Math.max(1, x1 - x0));
      var eyePx = [];
      for (var y = Math.ceil(y0); y <= y1; y++) for (var x = Math.ceil(x0); x <= x1; x++) {
        if (!pointInPoly(x, y, poly)) continue;
        if (Math.hypot(x - ic[0], y - ic[1]) < ir) continue;
        var v = px(x, y);
        eyePx.push([v[0], v[1], v[2], lum(LIN[v[0]], LIN[v[1]], LIN[v[2]])]);
      }
      // The brightest part of what's left is the eye white; corners and lash shadows are darker.
      eyePx.sort(function (a, b) { return b[3] - a[3]; });
      eyePx.slice(0, Math.ceil(eyePx.length * 0.4)).forEach(function (q) {
        if (q[0] >= 250 || q[1] >= 250 || q[2] >= 250) { clipped++; return; }
        white.push([LIN[q[0]], LIN[q[1]], LIN[q[2]]]);
      });
    });
    out.eyeOpen = Math.min.apply(null, openness);
    out.whiteCount = white.length + clipped;
    out.whiteClipped = out.whiteCount ? clipped / out.whiteCount : 0;
    if (white.length >= 6) out.white = [0, 1, 2].map(function (c) { return median(white.map(function (q) { return q[c]; })); });
    return out;
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
    if (median(withSkin.map(function (f) { return f.sideRatio; })) > 1.6) return { issue: "uneven" };
    var open = median(withFace.map(function (f) { return f.eyeOpen; }));
    var count = median(withFace.map(function (f) { return f.whiteCount; }));
    if (open < 0.2 || count < 12) return { issue: "eyes" };

    var skin = [0, 1, 2].map(function (c) { return median(withSkin.map(function (f) { return f.skin[c]; })); });
    var clippedShare = median(withFace.map(function (f) { return f.whiteClipped; }));
    var withWhite = withFace.filter(function (f) { return f.white; });
    var R = SETTINGS.scleraReflectance, white, eyesClipped = clippedShare > 0.3 || withWhite.length < withFace.length / 2;
    if (!eyesClipped) {
      white = [0, 1, 2].map(function (c) { return median(withWhite.map(function (f) { return f.white[c]; })); });
    } else {
      // Eye whites blown out: they're at least as bright as the camera can record.
      white = [1, 1, 1];
    }
    var wl = lum(white[0], white[1], white[2]);
    if (!eyesClipped && wl < lum(skin[0], skin[1], skin[2]) * 1.05) return { issue: "eyeShadow" };
    var k = SETTINGS.whiteBalanceFromEyes;
    var refl = [0, 1, 2].map(function (c) {
      var balance = Math.pow(wl / Math.max(1e-4, white[c]), k);
      return Math.min(1, skin[c] * balance * R / wl);
    });
    var lab = labFromLinear(refl[0], refl[1], refl[2]);
    // If the eye whites were blown out, the true skin is at least this deep.
    return { issue: null, ita: ita(lab), lab: lab, deeperThan: eyesClipped };
  }

  // ITA of each reference shade, worked out once from its swatch.
  REFERENCE.forEach(function (r) {
    var h = r[3];
    r.ita = ita(labFromLinear(LIN[parseInt(h.substr(1, 2), 16)], LIN[parseInt(h.substr(3, 2), 16)], LIN[parseInt(h.substr(5, 2), 16)]));
  });

  // Finds the nearest reference shade and returns its gemstone, plus the
  // closest neighboring gemstone as the runner-up.
  function classify(itaValue, deeperThan) {
    var ranked = REFERENCE.slice().sort(function (a, b) { return Math.abs(a.ita - itaValue) - Math.abs(b.ita - itaValue); });
    var near = ranked[0], best = near[4];
    if (deeperThan) {
      // The eye whites were too bright to read, so the skin is at least this deep.
      var deeper = Math.min(GEMSTONES - 1, best + 1);
      return { best: deeper, alt: deeper === best ? best - 1 : best, between: true, reference: near };
    }
    var other = null;
    for (var i = 1; i < ranked.length; i++) if (ranked[i][4] !== best) { other = ranked[i]; break; }
    var alt = other ? other[4] : (best > 0 ? best - 1 : 1);
    var between = !!other && Math.abs(other.ita - itaValue) - Math.abs(near.ita - itaValue) < SETTINGS.betweenMargin;
    return { best: best, alt: alt, between: between, reference: near };
  }

  var MESSAGES = {
    loading: "Getting things ready…",
    dark: "It's too dark. Face a window or a bright lamp.",
    noFace: "Center your face in the oval.",
    far: "Bring your phone a little closer.",
    eyes: "Look straight at the camera with your eyes open. Glasses off if you can.",
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
          '<p>Your camera finds the closest of the ten shades in a few seconds.</p>' +
          '<ul>' +
            '<li><b>1</b><span>Face a window or a bright light.</span></li>' +
            '<li><b>2</b><span>Look straight at the camera with your eyes open. Glasses off if you can.</span></li>' +
            '<li><b>3</b><span>Hold still. Your shade shows up on its own.</span></li>' +
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
    var stream = null, mesh = null, liveTimer = null, busy = false, result = null, focusAfter = null, goodChecks = 0, session = 0;

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
    function fail(msg) { q("[data-error]").textContent = msg; show("error"); }

    // Grabs the current frame and finds the face. Resolves to a frame reading.
    function readFrame() {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || !mesh) return Promise.resolve(null);
      var sc = Math.min(1, SETTINGS.analysisWidth / vw), w = Math.round(vw * sc), h = Math.round(vh * sc);
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      return mesh.detect(canvas).then(function (r) {
        var f = r && r.multiFaceLandmarks && r.multiFaceLandmarks[0];
        var lm = f && f.length >= 478 ? f.map(function (p) { return [p.x * w, p.y * h]; }) : null;
        return analyzeFrame(ctx, w, h, lm);
      });
    }

    function loop(my) {
      if (my !== session || !stream) return;
      if (busy) { liveTimer = setTimeout(function () { loop(my); }, 300); return; }
      readFrame().then(function (fr) {
        if (my !== session || busy) return;
        if (fr) {
          var res = combine([fr]);
          setStatus(res.issue);
          goodChecks = res.issue ? 0 : goodChecks + 1;
          if (goodChecks >= SETTINGS.goodChecksBeforeAuto) { capture(); return; }
        }
        liveTimer = setTimeout(function () { loop(my); }, 350);
      }, function () { liveTimer = setTimeout(function () { loop(my); }, 600); });
    }

    function startCamera() {
      show("camera");
      setStatus("loading"); status.classList.remove("ok");
      captureBtn.disabled = true; goodChecks = 0;
      var my = ++session;
      var cam = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } } });
      Promise.all([cam, loadMesh().catch(function () { return null; })]).then(function (arr) {
        if (my !== session) { arr[0].getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = arr[0]; mesh = arr[1];
        if (!mesh) { stopCamera(); fail("Find My Shade couldn't load on this browser. Try updating your browser, or pick your shade below."); return; }
        video.srcObject = stream;
        var pl = video.play(); if (pl && pl.catch) pl.catch(function () {});
        function ready() { captureBtn.disabled = false; setStatus("noFace"); setTimeout(function () { loop(my); }, 700); }
        if (video.readyState >= 1) ready(); else video.onloadedmetadata = ready;
      }).catch(function (e) {
        if (my !== session) return;
        var inApp = /Instagram|FBAN|FBAV|TikTok|Snapchat|Line\//i.test(navigator.userAgent);
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
          fail(inApp
            ? "This app's built-in browser blocked the camera. Tap the menu (•••), choose Open in Browser, then try again."
            : "Camera access was blocked. To use Find My Shade, allow camera access for this site in your browser settings and try again.");
        } else if (e && e.name === "NotFoundError") fail("We couldn't find a camera on this device.");
        else fail("The camera didn't start. Close other apps that might be using it and try again.");
      });
    }

    function capture() {
      if (busy || !stream) return;
      busy = true; captureBtn.disabled = true; goodChecks = 0;
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
          if (res.issue) { setStatus(res.issue); loop(my); return; }
          result = classify(res.ita, res.deeperThan);
          stopCamera();
          showResult();
        }, function () { busy = false; captureBtn.disabled = false; loop(my); });
      })();
    }

    function showResult() {
      var best = shades[result.best], alt = shades[result.alt];
      q("[data-best-dot]").style.background = best.color;
      q("[data-best-name]").textContent = best.name;
      q("[data-use-best]").textContent = "Use " + best.name;
      q("[data-note]").textContent = result.between
        ? "You're right between " + best.name + " and " + alt.name + ". Go with whichever feels more like you."
        : "If another shade feels more like you, pick that one instead.";
      q("[data-alt-dot]").style.background = alt.color;
      q("[data-use-alt]").textContent = alt.name;
      show("result");
      q("[data-use-best]").focus();
    }

    function choose(shade) {
      shade.input.checked = true;
      shade.input.dispatchEvent(new Event("change", { bubbles: true }));
      if (picked) picked.textContent = "Suggested by Find My Shade: " + shade.name + ". You can change it anytime.";
      focusAfter = shade.input;
      close();
    }

    function open() {
      result = null;
      if (!canUseCamera) {
        fail(window.isSecureContext === false ? "The camera only works on the secure (https) version of this page." : "This browser can't use the camera. Try Safari or Chrome.");
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

  window.PulseShadeFinder = { REFERENCE: REFERENCE, analyzeFrame: analyzeFrame, combine: combine, classify: classify, loadMesh: loadMesh, SETTINGS: SETTINGS, labFromLinear: labFromLinear, ita: ita };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
