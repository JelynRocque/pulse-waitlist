/*
 * Pulse "Find My Shade" camera helper (v2: white paper reference).
 *
 * Why the paper: phone cameras auto-adjust brightness and color so every
 * face comes out looking "normal", which pushes very different skin tones
 * toward the same middle shade. A sheet of white paper held beside the face
 * is in the same light and goes through the same camera adjustments, so
 * dividing skin by paper cancels them out and leaves the skin's real color.
 *
 * That color is turned into an Individual Typology Angle (ITA), the standard
 * skin-colorimetry measure used in dermatology research, and mapped to the
 * ten Monk shades. Shade names and swatches are read from the page.
 *
 * Everything runs in the browser. No image or video is saved, uploaded or
 * sent, and there is no face detection or face mapping. Only the shade the
 * person picks is submitted, the same as tapping it by hand.
 *
 * Use: add a button with data-shade-finder="<radio name>" next to a group of
 * ten shade radios, lightest first. Each radio's label needs an <i> swatch and
 * the shade name as text. Radios with value "prefer_not" are skipped.
 */
(function () {
  "use strict";

  var SETTINGS = {
    // How much light ordinary white paper reflects (copy paper ~0.85-0.9).
    paperReflectance: 0.86,
    // ITA cut points between Monk shades, lightest to deepest. ITA above the
    // first number is shade 1; below the last is shade 10. Based on the
    // published ITA skin categories (very light > 55, light 41-55,
    // intermediate 28-41, tan 10-28, brown -30-10, dark < -30), split to ten.
    // Adjust after testing with people who know their shade.
    itaCuts: [62, 55, 48, 41, 28, 10, -10, -30, -50],
    // Within this many degrees of a cut point, the result says it's between two shades.
    betweenMargin: 3,
    framesPerReading: 12,
    frameGapMs: 70,
    goodChecksBeforeAuto: 2
  };

  // ---------- Color math ----------
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  var LIN = new Float32Array(256);
  for (var li = 0; li < 256; li++) LIN[li] = lin(li);

  // Linear RGB (0-1) -> CIELAB (D65)
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
    var n = s.length; if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  // ---------- Layout, as fractions of the 3:4 viewfinder ----------
  var FACE = { cx: 0.40, cy: 0.45, rx: 0.27, ry: 0.28 };
  var SKIN = { x0: 0.29, x1: 0.51, y0: 0.47, y1: 0.56 };   // cheeks + nose, below the eyes, above the mouth
  var PAPER = { x0: 0.72, x1: 0.95, y0: 0.28, y1: 0.64 };  // box shown on screen
  var PAPER_IN = { x0: 0.76, x1: 0.91, y0: 0.33, y1: 0.59 }; // area actually read
  var CW = 240, CH = 320;

  // Reads one frame (already mirrored to match the screen).
  function analyzeFrame(ctx) {
    var img = ctx.getImageData(0, 0, CW, CH).data;
    var frameSum = 0, frameCount = 0;
    for (var p = 0; p < img.length; p += 16) { frameSum += (img[p] + img[p + 1] + img[p + 2]) / 3; frameCount++; }

    // Skin
    var sx0 = Math.round(SKIN.x0 * CW), sx1 = Math.round(SKIN.x1 * CW), sy0 = Math.round(SKIN.y0 * CH), sy1 = Math.round(SKIN.y1 * CH);
    var mid = (sx0 + sx1) / 2, skin = [], left = [], right = [], tried = 0;
    for (var y = sy0; y < sy1; y++) for (var x = sx0; x < sx1; x++) {
      var i = (y * CW + x) * 4, r = img[i], g = img[i + 1], b = img[i + 2];
      tried++;
      if (r >= 250 || g >= 250 || b >= 250) continue;
      var R = LIN[r], G = LIN[g], B = LIN[b], L = lum(R, G, B);
      if (L < 0.0015 || R <= B) continue; // too dark to read, or not skin-colored
      skin.push([R, G, B, L]);
      (x < mid ? left : right).push(L);
    }
    var skinMean = null;
    if (skin.length) {
      skin.sort(function (a, c) { return a[3] - c[3]; });
      var lo = Math.floor(skin.length * 0.25), hi = Math.ceil(skin.length * 0.75), s = [0, 0, 0], n = 0;
      for (var k = lo; k < hi; k++) { s[0] += skin[k][0]; s[1] += skin[k][1]; s[2] += skin[k][2]; n++; }
      if (n) skinMean = [s[0] / n, s[1] / n, s[2] / n];
    }
    var lr = left.length && right.length ? Math.max(median(left), median(right)) / Math.max(1e-4, Math.min(median(left), median(right))) : 1;

    // Paper: brightest 60% of the box, in case it doesn't fill it
    var px0 = Math.round(PAPER_IN.x0 * CW), px1 = Math.round(PAPER_IN.x1 * CW), py0 = Math.round(PAPER_IN.y0 * CH), py1 = Math.round(PAPER_IN.y1 * CH);
    var pp = [];
    for (y = py0; y < py1; y++) for (x = px0; x < px1; x++) {
      i = (y * CW + x) * 4; r = img[i]; g = img[i + 1]; b = img[i + 2];
      pp.push([r, g, b, lum(LIN[r], LIN[g], LIN[b])]);
    }
    pp.sort(function (a, c) { return c[3] - a[3]; });
    var top = pp.slice(0, Math.ceil(pp.length * 0.6)), clipped = 0, ps = [0, 0, 0], pn = 0, lums = [];
    top.forEach(function (q) {
      if (q[0] >= 250 || q[1] >= 250 || q[2] >= 250) { clipped++; return; }
      ps[0] += LIN[q[0]]; ps[1] += LIN[q[1]]; ps[2] += LIN[q[2]]; pn++; lums.push(q[3]);
    });
    var paperMean = pn ? [ps[0] / pn, ps[1] / pn, ps[2] / pn] : null, cv = 1;
    if (lums.length > 1) {
      var m = lums.reduce(function (a, c) { return a + c; }, 0) / lums.length;
      var v = lums.reduce(function (a, c) { return a + (c - m) * (c - m); }, 0) / lums.length;
      cv = m > 0 ? Math.sqrt(v) / m : 1;
    }

    return {
      frameMean: frameSum / frameCount,
      skin: skinMean, skinShare: tried ? skin.length / tried : 0, lr: lr,
      paper: paperMean, paperClipped: top.length ? clipped / top.length : 1, paperCV: cv
    };
  }

  // Combines frames, checks conditions, and returns the skin's ITA.
  function combine(frames) {
    function med(key, idx) {
      return median(frames.map(function (f) { return f[key] ? (idx == null ? f[key] : f[key][idx]) : NaN; }).filter(function (v) { return !isNaN(v); }));
    }
    var haveSkin = frames.filter(function (f) { return f.skin; }).length > frames.length / 2;
    var havePaper = frames.filter(function (f) { return f.paper; }).length > frames.length / 2;
    var skin = haveSkin ? [med("skin", 0), med("skin", 1), med("skin", 2)] : null;
    var paper = havePaper ? [med("paper", 0), med("paper", 1), med("paper", 2)] : null;
    var frameMean = med("frameMean"), skinShare = med("skinShare"), lr = med("lr");
    var paperClipped = med("paperClipped"), paperCV = med("paperCV");

    var issue = null;
    if (frameMean < 28) issue = "dark";
    else if (!skin || skinShare < 0.35) issue = "center";
    else if (paperClipped > 0.35) issue = "paperBright";
    else if (!paper) issue = "paper";
    else {
      var pL = lum(paper[0], paper[1], paper[2]), sL = lum(skin[0], skin[1], skin[2]);
      var pMax = Math.max(paper[0], paper[1], paper[2]), pMin = Math.min(paper[0], paper[1], paper[2]);
      if (pL < sL * 1.6 || paperCV > 0.25 || pMin <= 0 || pMax / pMin > 2.2) issue = "paper";
      else if (lr > 1.6) issue = "uneven";
    }
    if (issue) return { issue: issue };

    var k = SETTINGS.paperReflectance;
    var refl = [0, 1, 2].map(function (c) { return Math.min(1, skin[c] / paper[c] * k); });
    var lab = labFromLinear(refl[0], refl[1], refl[2]);
    return { issue: null, lab: lab, ita: ita(lab), reflectance: refl };
  }

  // ITA -> shade index (0 = lightest), plus the nearest neighbor shade.
  function classify(itaValue) {
    var cuts = SETTINGS.itaCuts, idx = cuts.length;
    for (var c = 0; c < cuts.length; c++) if (itaValue > cuts[c]) { idx = c; break; }
    var above = idx > 0 ? cuts[idx - 1] : Infinity, below = idx < cuts.length ? cuts[idx] : -Infinity;
    var toAbove = above - itaValue, toBelow = itaValue - below;
    var alt = toAbove < toBelow ? idx - 1 : idx + 1;
    if (alt < 0) alt = 1; if (alt > cuts.length) alt = cuts.length - 1;
    return { best: idx, alt: alt, between: Math.min(toAbove, toBelow) < SETTINGS.betweenMargin };
  }

  var MESSAGES = {
    dark: "It's too dark. Face a window or a bright lamp.",
    center: "Fit your face inside the oval.",
    paper: "Hold a piece of white paper flat inside the box, right beside your face.",
    paperBright: "The paper is too bright. Step back from the light a little, or tilt the paper slightly.",
    uneven: "One side of your face is in shadow. Turn so the light hits you straight on.",
    ok: "Perfect. Hold still…",
    reading: "Hold still…"
  };

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
    ".sf-need{display:flex;gap:14px;align-items:center;background:var(--paper,#FFF3E8);border-radius:14px;padding:14px}" +
    ".sf-need svg{width:64px;height:64px;flex:none}" +
    ".sf-need strong{display:block;font-size:15px;color:var(--espresso,#261000);margin-bottom:2px}" +
    ".sf-need span{display:block;line-height:1.5;font-size:13px;color:var(--espresso-soft,#5B4436)}" +
    ".sf ul{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:14px}" +
    ".sf li{display:flex;gap:10px;align-items:flex-start}" +
    ".sf li b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--paper,#FFF3E8);color:var(--auburn,#96262C);font-size:12px;display:grid;place-items:center;margin-top:1px}" +
    ".sf-private{display:flex;gap:10px;align-items:flex-start;font-size:12px;color:var(--espresso-soft,#5B4436)}" +
    ".sf-private svg{width:16px;height:16px;flex:none;margin-top:1px;color:var(--auburn,#96262C)}" +
    ".sf-btn{font:inherit;font-weight:700;font-size:15px;letter-spacing:.03em;border:0;border-radius:999px;padding:14px 20px;cursor:pointer;background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7);width:100%}" +
    ".sf-btn:hover{background:var(--auburn,#96262C)}" +
    ".sf-btn[disabled]{opacity:.6;cursor:default}" +
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
    ".sf-link{font:inherit;font-size:14px;font-weight:600;color:var(--espresso,#261000);background:none;border:0;padding:4px 0;text-decoration:underline;text-underline-offset:3px;cursor:pointer;justify-self:center}" +
    ".sf [hidden]{display:none !important}";

  var ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  var ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
  // Face with a sheet of paper held beside it
  var ICON_PAPER = '<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="25" cy="30" rx="13" ry="17" fill="#C9966B"/><path d="M12 62c1-9 6-13 13-13s12 4 13 13" fill="#C9966B"/><rect x="42" y="14" width="17" height="24" rx="2" fill="#fff" stroke="#AB5B1E" stroke-width="1.5" transform="rotate(4 50 26)"/></svg>';

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function pct(v, total) { return (v * total).toFixed(1); }

  function setup(trigger) {
    var groupName = trigger.getAttribute("data-shade-finder");
    var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + groupName + '"]'));
    var shades = radios.filter(function (r) { return r.value !== "prefer_not"; }).map(function (r) {
      var label = r.closest("label"), sw = label && label.querySelector("i");
      return { input: r, name: label ? label.textContent.trim() : r.value, color: sw ? getComputedStyle(sw).backgroundColor : "#ccc" };
    });
    if (shades.length !== SETTINGS.itaCuts.length + 1) return;

    var canUseCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
    trigger.hidden = false;
    var picked = document.getElementById(trigger.getAttribute("aria-describedby") || "") || null;

    var W = 300, H = 400;
    var guide =
      '<svg viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><mask id="sfMask"><rect width="300" height="400" fill="#fff"/>' +
          '<ellipse cx="' + pct(FACE.cx, W) + '" cy="' + pct(FACE.cy, H) + '" rx="' + pct(FACE.rx, W) + '" ry="' + pct(FACE.ry, H) + '" fill="#000"/>' +
          '<rect x="' + pct(PAPER.x0, W) + '" y="' + pct(PAPER.y0, H) + '" width="' + pct(PAPER.x1 - PAPER.x0, W) + '" height="' + pct(PAPER.y1 - PAPER.y0, H) + '" rx="6" fill="#000"/>' +
        '</mask></defs>' +
        '<rect width="300" height="400" fill="rgba(38,16,0,.45)" mask="url(#sfMask)"/>' +
        '<ellipse cx="' + pct(FACE.cx, W) + '" cy="' + pct(FACE.cy, H) + '" rx="' + pct(FACE.rx, W) + '" ry="' + pct(FACE.ry, H) + '" fill="none" stroke="#FFFBF7" stroke-width="2" stroke-dasharray="6 6"/>' +
        '<rect x="' + pct(PAPER.x0, W) + '" y="' + pct(PAPER.y0, H) + '" width="' + pct(PAPER.x1 - PAPER.x0, W) + '" height="' + pct(PAPER.y1 - PAPER.y0, H) + '" rx="6" fill="none" stroke="#E4A524" stroke-width="2" stroke-dasharray="6 6"/>' +
        '<text x="' + pct((PAPER.x0 + PAPER.x1) / 2, W) + '" y="' + (PAPER.y0 * H - 8).toFixed(1) + '" text-anchor="middle" fill="#FFFBF7" font-size="12" font-weight="600" font-family="Raleway, Arial, sans-serif">Paper</text>' +
      '</svg>';

    var dlg = el("dialog", { "class": "sf", "aria-labelledby": "sfTitle" });
    dlg.innerHTML =
      '<div class="sf-body">' +
        '<div class="sf-head"><h2 id="sfTitle">Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +

        '<div data-step="intro" class="sf-step">' +
          '<div class="sf-need">' + ICON_PAPER + '<div><strong>Grab a piece of white paper</strong><span>Printer paper, a receipt or a paper towel. Your camera compares your skin to it, so lighting can\'t throw off your shade.</span></div></div>' +
          '<ul>' +
            '<li><b>1</b><span>Face a window or a bright light.</span></li>' +
            '<li><b>2</b><span>Hold the paper flat, right beside your face, in the box on screen.</span></li>' +
            '<li><b>3</b><span>Hold still. Your shade shows up on its own.</span></li>' +
          '</ul>' +
          '<button type="button" class="sf-btn" data-start>Start Camera</button>' +
          '<div class="sf-private">' + ICON_LOCK + '<span>Your camera image stays on your phone. Pulse never saves or sees it. Only the shade you choose is sent.</span></div>' +
          '<button type="button" class="sf-link" data-nopaper>No paper? Pick by eye</button>' +
        '</div>' +

        '<div data-step="camera" hidden class="sf-step">' +
          '<div class="sf-view">' +
            '<video playsinline muted autoplay></video>' + guide +
            '<div class="sf-status" role="status" aria-live="polite">Starting camera…</div>' +
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
    var video = q("video"), status = q(".sf-status"), captureBtn = q("[data-capture]");
    var canvas = document.createElement("canvas"); canvas.width = CW; canvas.height = CH;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var stream = null, liveTimer = null, busy = false, result = null, focusAfter = null, goodChecks = 0, expStep = 0;

    function show(step) {
      ["intro", "camera", "result", "error"].forEach(function (s) { q('[data-step="' + s + '"]').hidden = s !== step; });
    }
    function stopCamera() {
      clearInterval(liveTimer); liveTimer = null;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null; video.srcObject = null;
    }
    function grab() {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return false;
      // Match object-fit: cover, and mirror like the preview, so the guides line up.
      var target = CW / CH, sw = vw, sh = vh, sx = 0, sy = 0;
      if (vw / vh > target) { sw = vh * target; sx = (vw - sw) / 2; } else { sh = vw / target; sy = (vh - sh) / 2; }
      ctx.save(); ctx.translate(CW, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, CW, CH);
      ctx.restore();
      return true;
    }
    function setStatus(issue) {
      status.textContent = MESSAGES[issue || "ok"];
      status.classList.toggle("ok", !issue);
    }
    // Where the browser allows it (mostly Android Chrome), turn exposure down
    // a little so the paper isn't blown out.
    function lowerExposure() {
      try {
        var track = stream && stream.getVideoTracks()[0];
        var caps = track && track.getCapabilities && track.getCapabilities();
        if (!caps || !caps.exposureCompensation || expStep >= 3) return;
        expStep++;
        var c = caps.exposureCompensation, val = Math.max(c.min, -0.5 * expStep);
        track.applyConstraints({ advanced: [{ exposureCompensation: val }] }).catch(function () {});
      } catch (e) {}
    }
    function liveCheck() {
      if (busy || !grab()) return;
      var res = combine([analyzeFrame(ctx)]);
      if (res.issue === "paperBright") lowerExposure();
      setStatus(res.issue);
      goodChecks = res.issue ? 0 : goodChecks + 1;
      if (goodChecks >= SETTINGS.goodChecksBeforeAuto) capture();
    }

    function startCamera() {
      show("camera");
      status.textContent = "Starting camera…"; status.classList.remove("ok");
      captureBtn.disabled = true; goodChecks = 0; expStep = 0;
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }
      }).then(function (s) {
        stream = s;
        video.srcObject = s;
        var pl = video.play(); if (pl && pl.catch) pl.catch(function () {});
        video.onloadedmetadata = function () {
          captureBtn.disabled = false;
          setTimeout(function () { if (stream && !liveTimer) liveTimer = setInterval(liveCheck, 500); }, 900);
        };
      }).catch(function (e) {
        var inApp = /Instagram|FBAN|FBAV|TikTok|Snapchat|Line\//i.test(navigator.userAgent);
        var msg;
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
          msg = inApp
            ? "This app's built-in browser blocked the camera. Tap the menu (•••), choose Open in Browser, then try again."
            : "Camera access was blocked. To use Find My Shade, allow camera access for this site in your browser settings and try again.";
        } else if (e && e.name === "NotFoundError") {
          msg = "We couldn't find a camera on this device.";
        } else {
          msg = "The camera didn't start. Close other apps that might be using it and try again.";
        }
        q("[data-error]").textContent = msg;
        show("error");
      });
    }

    function capture() {
      if (busy || !stream) return;
      busy = true; captureBtn.disabled = true; goodChecks = 0;
      status.textContent = MESSAGES.reading; status.classList.add("ok");
      var frames = [];
      (function next() {
        if (!stream) { busy = false; return; }
        if (grab()) frames.push(analyzeFrame(ctx));
        if (frames.length < SETTINGS.framesPerReading) { setTimeout(next, SETTINGS.frameGapMs); return; }
        busy = false; captureBtn.disabled = false;
        var res = combine(frames);
        if (res.issue) { setStatus(res.issue); return; }
        result = classify(res.ita);
        stopCamera();
        showResult();
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

    function showPickByEye(msg) {
      q("[data-error]").textContent = msg || "";
      q("[data-error]").hidden = !msg;
      show("error");
    }

    function open() {
      result = null;
      if (!canUseCamera) {
        showPickByEye(window.isSecureContext === false
          ? "The camera only works on the secure (https) version of this page."
          : "This browser can't use the camera. Try Safari or Chrome.");
      } else {
        show("intro");
      }
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
      document.documentElement.style.overflow = "hidden";
    }
    function close() {
      stopCamera();
      if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
    }

    dlg.addEventListener("close", function () {
      stopCamera(); busy = false;
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
      else if (t.hasAttribute("data-nopaper")) showPickByEye("");
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

  window.PulseShadeFinder = { analyzeFrame: analyzeFrame, combine: combine, classify: classify, labFromLinear: labFromLinear, ita: ita, SETTINGS: SETTINGS, FACE: FACE, SKIN: SKIN, PAPER: PAPER };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
