/*
 * Pulse "Find My Shade" camera matcher (v4: white paper reference + jawline check).
 *
 * How it reads depth: the person holds a sheet of plain white paper flat in the
 * box beside their face. The paper sits in the same light as their cheek and
 * goes through the same camera adjustments, and plain printer paper reflects
 * about the same amount of light everywhere, so cheek ÷ paper cancels the
 * camera's auto-brightness and gives the skin's true depth (CIELAB L*). The
 * depth picks the gemstone from the shared bands in assets/shade-library.js.
 *
 * Why not the eye whites any more (v3): tested Oct 22, 2026 they read deeper
 * skin as lighter. A friend with deep skin (glasses, indoor light) got
 * Moonstone, and on the Monk Skin Tone Examples set (Google/TONL, testing use
 * only) the eye-white reading was about two gemstones off on average. Eye
 * whites are a few dozen pixels on a phone, partly hidden by lids, lashes and
 * glasses; a sheet of paper is thousands of pixels, flat and fully visible.
 *
 * Then the jawline check: the screen fills with the gemstone the camera found.
 * Holding the phone to their jawline in a mirror, the person answers Lighter,
 * A Match or Deeper, and the color steps one gemstone at a time until it
 * matches. The camera does the heavy lifting; the check catches anything the
 * light or camera got wrong.
 *
 * Face tracking (MediaPipe Face Mesh, Apache 2.0, served from /assets/vendor)
 * runs on the device to find the cheeks. No image, video or measurement is
 * saved, uploaded or sent anywhere. Only the shade the person picks is
 * submitted, the same as tapping it by hand.
 *
 * Testing: add ?sfdebug=1 to the page URL to show the measured depth and the
 * cheek and paper readings on the result screen.
 *
 * Use: add a button with data-shade-finder="<radio name>" next to a group of
 * ten shade radios, lightest first. Each radio's label needs an <i> swatch and
 * the shade name as text. Radios with value "prefer_not" are skipped.
 */
(function () {
  "use strict";

  var SETTINGS = {
    // Light plain white printer paper reflects (0-1). Sets the light-to-deep
    // scale. Lower it if results run too deep; raise it if too light.
    paperReflectance: 0.88,
    // How much to trust the paper for color balance (1 = paper is pure white).
    whiteBalanceFromPaper: 0.9,
    // Within this much depth of a gemstone boundary, the result says it's between two.
    betweenMargin: 1.5,
    framesPerReading: 8,
    goodChecksBeforeAuto: 2,
    analysisWidth: 720
  };

  // Guide shapes in the 300 x 400 viewfinder, as the person sees it (mirrored).
  var OVAL = { cx: 112, cy: 182, rx: 84, ry: 114 };
  var PAPER = { x: 208, y: 112, w: 80, h: 150 };

  // Lower depth limit of gemstones 1-9 (Pearl is open above, Onyx open below).
  var EDGES = (window.PULSE_SHADES && window.PULSE_SHADES.edges) || [83, 76, 69, 62, 55, 48, 41, 34, 27];
  var GEMSTONES = EDGES.length + 1;
  var DEBUG = /[?&]sfdebug=1/.test(location.search);

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

  var CHEEKS = [50, 280, 205, 425]; // upper and lower cheeks, both sides
  var FACE_SIDES = [234, 454];

  // Viewfinder (mirrored, object-fit: cover) -> frame pixels.
  // view = {u0, v0, uw, vh}: the part of the frame the viewfinder shows, as fractions.
  function toFrame(view, w, h, x, y) {
    var u = x / 300, v = y / 400;
    return [(view.u0 + (1 - u) * view.uw) * w, (view.v0 + v * view.vh) * h];
  }

  // Reads cheek skin and the paper from one frame. lm = face landmarks in pixels.
  function analyzeFrame(ctx, w, h, lm, view) {
    var out = { face: !!lm };
    var frame = ctx.getImageData(0, 0, w, h).data;
    var fs = 0, fc = 0;
    for (var p = 0; p < frame.length; p += 64) { fs += (frame[p] + frame[p + 1] + frame[p + 2]) / 3; fc++; }
    out.frameMean = fs / fc;
    function px(x, y) { var i = ((y | 0) * w + (x | 0)) * 4; return [frame[i], frame[i + 1], frame[i + 2]]; }

    // Paper: the middle of the guide box (a margin in from the edges, so fingers and edges stay out)
    var a = toFrame(view, w, h, PAPER.x + PAPER.w * 0.15, PAPER.y + PAPER.h * 0.12);
    var b = toFrame(view, w, h, PAPER.x + PAPER.w * 0.85, PAPER.y + PAPER.h * 0.88);
    var x0 = Math.max(0, Math.min(a[0], b[0])), x1 = Math.min(w - 1, Math.max(a[0], b[0]));
    var y0 = Math.max(0, Math.min(a[1], b[1])), y1 = Math.min(h - 1, Math.max(a[1], b[1]));
    var paper = [], clipped = 0, sats = [];
    for (var y = Math.ceil(y0); y <= y1; y += 2) for (var x = Math.ceil(x0); x <= x1; x += 2) {
      var v = px(x, y), mx = Math.max(v[0], v[1], v[2]);
      if (mx >= 250) { clipped++; continue; }
      sats.push(mx ? (mx - Math.min(v[0], v[1], v[2])) / mx : 1);
      paper.push([LIN[v[0]], LIN[v[1]], LIN[v[2]], lum(LIN[v[0]], LIN[v[1]], LIN[v[2]])]);
    }
    var total = paper.length + clipped;
    out.paperClipped = total ? clipped / total : 0;
    if (paper.length >= 40) {
      paper.sort(function (p1, p2) { return p1[3] - p2[3]; });
      out.paperSpread = paper[Math.floor(paper.length * 0.9)][3] / Math.max(1e-4, paper[Math.floor(paper.length * 0.1)][3]);
      out.paperSat = median(sats);
      var lo = Math.floor(paper.length * 0.25), hi = Math.ceil(paper.length * 0.75), s3 = [0, 0, 0], n3 = 0;
      for (var k = lo; k < hi; k++) { s3[0] += paper[k][0]; s3[1] += paper[k][1]; s3[2] += paper[k][2]; n3++; }
      out.paper = [s3[0] / n3, s3[1] / n3, s3[2] / n3];
    }
    if (!lm) return out;

    var faceW = Math.hypot(lm[FACE_SIDES[0]][0] - lm[FACE_SIDES[1]][0], lm[FACE_SIDES[0]][1] - lm[FACE_SIDES[1]][1]);
    var cx = (lm[FACE_SIDES[0]][0] + lm[FACE_SIDES[1]][0]) / 2, cy = (lm[FACE_SIDES[0]][1] + lm[FACE_SIDES[1]][1]) / 2;
    var oc = toFrame(view, w, h, OVAL.cx, OVAL.cy);
    out.faceShare = faceW / (view.uw * w);
    out.offCenter = Math.hypot(cx - oc[0], cy - oc[1]) / (view.uw * w);

    // Skin: four cheek patches
    var rad = faceW * 0.055, patches = [], skinTried = 0, skinClipped = 0, spreads = [];
    CHEEKS.forEach(function (idx) {
      var c = lm[idx], vals = [];
      for (var yy = Math.max(0, c[1] - rad); yy < Math.min(h, c[1] + rad); yy++) {
        for (var xx = Math.max(0, c[0] - rad); xx < Math.min(w, c[0] + rad); xx++) {
          if ((xx - c[0]) * (xx - c[0]) + (yy - c[1]) * (yy - c[1]) > rad * rad) continue;
          var q = px(xx, yy);
          skinTried++;
          if (q[0] >= 250 || q[1] >= 250 || q[2] >= 250) { skinClipped++; continue; }
          var R = LIN[q[0]], G = LIN[q[1]], B = LIN[q[2]];
          if (R <= B) continue;
          vals.push([R, G, B, lum(R, G, B)]);
        }
      }
      if (vals.length < 20) { patches.push(null); return; }
      vals.sort(function (p1, p2) { return p1[3] - p2[3]; });
      spreads.push(vals[Math.floor(vals.length * 0.9)][3] / Math.max(1e-4, vals[Math.floor(vals.length * 0.1)][3]));
      var l2 = Math.floor(vals.length * 0.25), h2 = Math.ceil(vals.length * 0.75), s = [0, 0, 0], n = 0;
      for (var k2 = l2; k2 < h2; k2++) { s[0] += vals[k2][0]; s[1] += vals[k2][1]; s[2] += vals[k2][2]; n++; }
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
    return out;
  }

  // Combines frames, checks conditions, returns the skin's depth.
  function combine(frames) {
    var withFace = frames.filter(function (f) { return f.face; });
    if (median(frames.map(function (f) { return f.frameMean; })) < 28) return { issue: "dark" };
    if (withFace.length < frames.length / 2) return { issue: "noFace" };
    if (median(withFace.map(function (f) { return f.faceShare; })) < 0.3) return { issue: "far" };
    if (median(withFace.map(function (f) { return f.offCenter; })) > 0.2) return { issue: "noFace" };
    var withSkin = withFace.filter(function (f) { return f.skin; });
    if (withSkin.length < withFace.length / 2) return { issue: "noFace" };
    if (median(withFace.map(function (f) { return f.skinClipped || 0; })) > 0.08) return { issue: "glare" };
    // Soft window light measures about 2-3 here; direct sun 14+.
    if (median(withFace.map(function (f) { return f.skinSpread || 1; })) > 6) return { issue: "glare" };
    if (median(withSkin.map(function (f) { return f.sideRatio; })) > 1.6) return { issue: "uneven" };

    var skin = [0, 1, 2].map(function (c) { return median(withSkin.map(function (f) { return f.skin[c]; })); });
    var sl = lum(skin[0], skin[1], skin[2]);
    var withPaper = withSkin.filter(function (f) { return f.paper; });
    if (median(withSkin.map(function (f) { return f.paperClipped; })) > 0.04) return { issue: "paperBright" };
    if (withPaper.length < withSkin.length / 2) return { issue: "noPaper" };
    var paper = [0, 1, 2].map(function (c) { return median(withPaper.map(function (f) { return f.paper[c]; })); });
    var pl = lum(paper[0], paper[1], paper[2]);
    // Paper is plain and even: low color, no shadow across it, and brighter than any skin.
    if (median(withPaper.map(function (f) { return f.paperSat; })) > 0.3 || pl < sl * 1.1) return { issue: "noPaper" };
    if (median(withPaper.map(function (f) { return f.paperSpread; })) > 1.6) return { issue: "paperShadow" };

    var k = SETTINGS.whiteBalanceFromPaper, R = SETTINGS.paperReflectance;
    var refl = [0, 1, 2].map(function (c) {
      var balance = Math.pow(pl / Math.max(1e-4, paper[c]), k);
      return Math.min(1, skin[c] * balance * R / pl);
    });
    var lab = labFromLinear(refl[0], refl[1], refl[2]);
    return { issue: null, depth: lab[0], ita: ita(lab), lab: lab, skinLum: sl, paperLum: pl };
  }

  // Depth -> gemstone (0 = Pearl ... 9 = Onyx), plus the nearer neighbor as runner-up.
  function classify(depth) {
    var best = GEMSTONES - 1;
    for (var i = 0; i < EDGES.length; i++) if (depth >= EDGES[i]) { best = i; break; }
    var top = best > 0 ? EDGES[best - 1] : Infinity, bottom = best < EDGES.length ? EDGES[best] : -Infinity;
    var toLighter = top - depth, toDeeper = depth - bottom;
    var alt = toLighter < toDeeper ? best - 1 : best + 1;
    if (alt < 0) alt = 1; if (alt > GEMSTONES - 1) alt = GEMSTONES - 2;
    return { best: best, alt: alt, between: Math.min(toLighter, toDeeper) < SETTINGS.betweenMargin, depth: depth };
  }

  // Jawline check: one answer. c = {cur, came} (came = the answer that led here).
  // Returns {cur, came} to show next, {pair:[a,b]} to choose between, or {done, best, alt}.
  function checkStep(c, answer) {
    if (answer === "match") return { done: true, best: c.cur, alt: c.cur === 0 ? 1 : c.cur === GEMSTONES - 1 ? GEMSTONES - 2 : (c.came === "lighter" ? c.cur + 1 : c.cur - 1) };
    if (answer === "lighter") {
      if (c.came === "deeper") return { pair: [c.cur - 1, c.cur] };      // deeper than the last one, lighter than this
      if (c.cur === 0) return { done: true, best: 0, alt: 1 };
      return { cur: c.cur - 1, came: "lighter" };
    }
    if (c.came === "lighter") return { pair: [c.cur, c.cur + 1] };
    if (c.cur === GEMSTONES - 1) return { done: true, best: GEMSTONES - 1, alt: GEMSTONES - 2 };
    return { cur: c.cur + 1, came: "deeper" };
  }

  var MESSAGES = {
    loading: "Getting things ready…",
    dark: "It's too dark. Face a window or a bright lamp.",
    noFace: "Fit your face in the oval.",
    far: "Bring your phone a little closer.",
    noPaper: "Hold a sheet of plain white paper flat in the box, right beside your cheek.",
    paperBright: "The paper is too bright for the camera. Step back from the window a little, or turn so the light is softer.",
    paperShadow: "Part of the paper is in shadow. Hold it flat, facing the camera, in the same light as your face.",
    glare: "The light is too strong on your face. Step out of direct sun, or turn so the light is soft and in front of you.",
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
    ".sf-view .sf-paper-label{font:700 11px/1 var(--body,Raleway,Arial,sans-serif);letter-spacing:.12em;fill:#FFFBF7}" +
    "dialog.sf.sf-full .sf-body{padding:0;gap:0;height:100%}" +
    ".sf-cmp{position:relative;display:grid;grid-template-rows:auto 1fr auto;min-height:min(640px,100dvh);height:100%}" +
    ".sf-cmp-top{display:flex;justify-content:space-between;align-items:center;padding:14px 14px 0 20px;gap:12px}" +
    ".sf-cmp-top span{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;padding:6px 10px;border-radius:999px;background:rgba(255,251,247,.86);color:#261000}" +
    ".sf-cmp-top .sf-x{background:rgba(255,251,247,.86);color:#261000}" +
    ".sf-colors{display:grid;grid-auto-flow:column;grid-auto-columns:1fr}" +
    ".sf-colors button{border:0;margin:0;padding:0 0 18px;cursor:pointer;display:flex;align-items:flex-end;justify-content:center;font:inherit;font-weight:700;font-size:15px;background:transparent}" +
    ".sf-colors button span{background:rgba(255,251,247,.92);color:#261000;padding:10px 16px;border-radius:999px}" +
    ".sf-ask{background:var(--warm-white,#FFFBF7);padding:16px 18px 20px;display:grid;gap:10px}" +
    ".sf-ask p{text-align:center;color:var(--espresso,#261000);font-size:15px;font-weight:600}" +
    ".sf-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}" +
    ".sf-ask .sf-btn{padding:13px 8px;font-size:14px;letter-spacing:.01em}" +
    ".sf-debug{font:12px/1.4 ui-monospace,Menlo,monospace;background:#261000;color:#FFFBF7;border-radius:10px;padding:10px;white-space:pre-wrap}" +
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
        '<div data-step="intro" class="sf-step">' +
          '<div class="sf-head"><h2 id="sfTitle">Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<p>Your camera reads your shade in a few seconds, then you check it against your jawline. You\'ll need a sheet of plain white paper.</p>' +
          '<ul>' +
            '<li><b>1</b><span>Face a window in daylight, out of direct sun, so your face is evenly lit.</span></li>' +
            '<li><b>2</b><span>Hold the paper flat beside your cheek, facing the camera, inside the box on screen.</span></li>' +
            '<li><b>3</b><span>Hold still. Your shade shows up on its own. Glasses are fine.</span></li>' +
          '</ul>' +
          '<label class="sf-consent"><input type="checkbox" data-consent><span>I agree to let Pulse map my face on this device to find my shade. The image and face measurements stay on my phone and are never saved or sent.</span></label>' +
          '<button type="button" class="sf-btn" data-start disabled>Start Camera</button>' +
        '</div>' +

        '<div data-step="camera" hidden class="sf-step">' +
          '<div class="sf-head"><h2>Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<div class="sf-view">' +
            '<video playsinline muted autoplay></video>' +
            '<svg viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">' +
              '<defs><mask id="sfMask"><rect width="300" height="400" fill="#fff"/>' +
                '<ellipse cx="' + OVAL.cx + '" cy="' + OVAL.cy + '" rx="' + OVAL.rx + '" ry="' + OVAL.ry + '" fill="#000"/>' +
                '<rect x="' + PAPER.x + '" y="' + PAPER.y + '" width="' + PAPER.w + '" height="' + PAPER.h + '" rx="6" fill="#000"/></mask></defs>' +
              '<rect width="300" height="400" fill="rgba(38,16,0,.45)" mask="url(#sfMask)"/>' +
              '<ellipse cx="' + OVAL.cx + '" cy="' + OVAL.cy + '" rx="' + OVAL.rx + '" ry="' + OVAL.ry + '" fill="none" stroke="#FFFBF7" stroke-width="2" stroke-dasharray="6 6"/>' +
              '<rect x="' + PAPER.x + '" y="' + PAPER.y + '" width="' + PAPER.w + '" height="' + PAPER.h + '" rx="6" fill="none" stroke="#E4A524" stroke-width="2" stroke-dasharray="6 6"/>' +
              '<text class="sf-paper-label" x="' + (PAPER.x + PAPER.w / 2) + '" y="' + (PAPER.y - 8) + '" text-anchor="middle">PAPER</text>' +
            '</svg>' +
            '<div class="sf-status" role="status" aria-live="polite"></div>' +
          '</div>' +
          '<button type="button" class="sf-btn" data-capture disabled>Get My Shade</button>' +
        '</div>' +

        '<div data-step="check" hidden class="sf-cmp">' +
          '<div class="sf-cmp-top"><span data-progress></span><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<div class="sf-colors" data-colors></div>' +
          '<div class="sf-ask">' +
            '<p data-question></p>' +
            '<div class="sf-row3" data-three><button type="button" class="sf-btn ghost" data-answer="lighter">Lighter</button><button type="button" class="sf-btn" data-answer="match">A Match</button><button type="button" class="sf-btn ghost" data-answer="deeper">Deeper</button></div>' +
          '</div>' +
        '</div>' +

        '<div data-step="result" hidden class="sf-step">' +
          '<div class="sf-head"><h2>Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<div class="sf-result"><i data-best-dot></i><div><small>Your Shade</small><strong data-best-name></strong></div></div>' +
          '<p data-note></p>' +
          '<div class="sf-alt"><i data-alt-dot></i><span>Also close: <button type="button" data-use-alt></button></span></div>' +
          '<button type="button" class="sf-btn" data-use-best></button>' +
          '<div class="sf-row"><button type="button" class="sf-btn ghost" data-retry>Try Again</button><button type="button" class="sf-btn ghost" data-close>Pick Myself</button></div>' +
          '<div class="sf-debug" data-debug hidden></div>' +
        '</div>' +

        '<div data-step="error" hidden class="sf-step">' +
          '<div class="sf-head"><h2>Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
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
    var stream = null, mesh = null, liveTimer = null, busy = false, reading = null, check = null, result = null, focusAfter = null, goodChecks = 0, session = 0, exposureLowered = false;

    consent.addEventListener("change", function () { startBtn.disabled = !consent.checked; });

    function show(step) {
      ["intro", "camera", "check", "result", "error"].forEach(function (s) { q('[data-step="' + s + '"]').hidden = s !== step; });
      dlg.classList.toggle("sf-full", step === "check");
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

    // Which part of the frame the viewfinder shows (object-fit: cover), as fractions of the frame.
    function viewOf(vw, vh) {
      var r = video.getBoundingClientRect(), bw = r.width || 3, bh = r.height || 4;
      var s = Math.max(bw / vw, bh / vh), visW = bw / s, visH = bh / s;
      return { u0: (vw - visW) / 2 / vw, uw: visW / vw, v0: (vh - visH) / 2 / vh, vh: visH / vh };
    }

    // Some phones let the page turn exposure down; when the paper washes out, try that once.
    function lowerExposure() {
      if (exposureLowered || !stream) return;
      exposureLowered = true;
      try {
        var t = stream.getVideoTracks()[0], c = t.getCapabilities ? t.getCapabilities() : {};
        if (c.exposureCompensation) t.applyConstraints({ advanced: [{ exposureCompensation: Math.max(c.exposureCompensation.min, -1) }] }).catch(function () {});
      } catch (e) { /* not supported */ }
    }

    function readFrame() {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || !mesh) return Promise.resolve(null);
      var sc = Math.min(1, SETTINGS.analysisWidth / vw), w = Math.round(vw * sc), h = Math.round(vh * sc);
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      var view = viewOf(vw, vh);
      return mesh.detect(canvas).then(function (r) {
        var f = r && r.multiFaceLandmarks && r.multiFaceLandmarks[0];
        var lm = f && f.length >= 468 ? f.map(function (p) { return [p.x * w, p.y * h]; }) : null;
        return analyzeFrame(ctx, w, h, lm, view);
      });
    }

    function loop(my) {
      if (my !== session || !stream) return;
      if (busy) { liveTimer = setTimeout(function () { loop(my); }, 300); return; }
      readFrame().then(function (fr) {
        if (my !== session || busy) return;
        if (fr) {
          var res = combine([fr]);
          if (res.issue === "paperBright") lowerExposure();
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
      captureBtn.disabled = true; goodChecks = 0; exposureLowered = false;
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
          reading = res;
          var c = classify(res.depth);
          stopCamera();
          check = { cur: c.best, came: null, camera: c };
          showCheck();
        }, function () { busy = false; captureBtn.disabled = false; loop(my); });
      })();
    }

    // ---------- Jawline check ----------
    function showCheck() {
      var box = q('[data-step="check"]'), colors = q("[data-colors]");
      colors.innerHTML = "";
      if (check.pair) {
        var a = check.pair[0], b = check.pair[1];
        box.style.background = "linear-gradient(90deg," + shades[a].color + " 50%," + shades[b].color + " 50%)";
        check.pair.forEach(function (i) {
          var btn = el("button", { type: "button", "data-pick": String(i), "aria-label": shades[i].name });
          btn.appendChild(el("span", null, shades[i].name));
          colors.appendChild(btn);
        });
        q("[data-question]").textContent = "You're between these two. Hold each half to your jawline and tap the closer one.";
        q("[data-three]").hidden = true;
        q("[data-progress]").textContent = "Last step";
      } else {
        box.style.background = shades[check.cur].color;
        colors.appendChild(el("div", { role: "img", "aria-label": shades[check.cur].name }));
        q("[data-question]").textContent = check.came
          ? "Compared with " + shades[check.cur].name + ", your skin is…"
          : "Your camera found " + shades[check.cur].name + ". Hold your phone to your jawline in a mirror. Your skin is…";
        q("[data-three]").hidden = false;
        q("[data-progress]").textContent = "Check your shade";
      }
      show("check");
    }
    function answer(a) {
      var n = checkStep(check, a);
      if (n.done) { result = { best: n.best, alt: n.alt, between: false }; showResult(); return; }
      if (n.pair) { check = { pair: n.pair, camera: check.camera }; showCheck(); return; }
      check = { cur: n.cur, came: n.came, camera: check.camera }; showCheck();
    }
    function pick(i) {
      result = { best: i, alt: check.pair[0] === i ? check.pair[1] : check.pair[0], between: true };
      showResult();
    }

    function showResult() {
      var best = shades[result.best], alt = shades[result.alt];
      q("[data-best-dot]").style.background = best.color;
      q("[data-best-name]").textContent = best.name;
      q("[data-use-best]").textContent = "Use " + best.name;
      q("[data-note]").textContent = result.between
        ? "You're between " + best.name + " and " + alt.name + ". Go with whichever feels more like you."
        : "If another shade feels more like you, pick that one instead.";
      q("[data-alt-dot]").style.background = alt.color;
      q("[data-use-alt]").textContent = alt.name;
      var dbg = q("[data-debug]");
      if (DEBUG && reading) {
        dbg.hidden = false;
        dbg.textContent = "depth " + reading.depth.toFixed(1) + " → camera " + shades[check.camera.best].name +
          "\nfinal " + best.name + "\ncheek Y " + reading.skinLum.toFixed(4) + "  paper Y " + reading.paperLum.toFixed(4) +
          "\nLab " + reading.lab.map(function (x) { return x.toFixed(1); }).join(", ");
      } else dbg.hidden = true;
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
      result = null; reading = null; check = null;
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
      dlg.classList.remove("sf-full");
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
      else if (t.hasAttribute("data-answer")) answer(t.getAttribute("data-answer"));
      else if (t.hasAttribute("data-pick")) pick(parseInt(t.getAttribute("data-pick"), 10));
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

  window.PulseShadeFinder = { EDGES: EDGES, analyzeFrame: analyzeFrame, combine: combine, classify: classify, checkStep: checkStep, loadMesh: loadMesh, SETTINGS: SETTINGS, labFromLinear: labFromLinear, ita: ita, OVAL: OVAL, PAPER: PAPER, toFrame: toFrame };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
