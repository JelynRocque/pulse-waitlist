/*
 * Pulse "Find My Shade" camera helper.
 *
 * Suggests the closest Monk Skin Tone shade from the phone's front camera.
 * Everything runs in the browser: frames are read into a canvas, a few small
 * patches of skin (forehead and both cheeks) are averaged into one color, and
 * that color is compared with the shade swatches already on the page.
 * No image or video is saved, uploaded or sent anywhere, and there is no face
 * detection or face mapping. Only the shade the person picks is submitted, the
 * same as tapping it by hand.
 *
 * Use: add a button with data-shade-finder="<radio name>" next to a group of
 * shade radios. Each radio's label needs an <i> swatch (its background is the
 * shade color) and the shade name as text. Radios with value "prefer_not" are
 * skipped.
 */
(function () {
  "use strict";

  var SETTINGS = {
    // Weights for matching. Lightness matters most for Monk shades; hue and
    // saturation from phone cameras drift with lighting, so they count less.
    weightL: 1.0,
    weightAB: 0.55,
    // Added to the measured lightness before matching. Leave at 0 until real
    // tests with people who know their shade show a consistent lean.
    lightnessOffset: 0,
    framesPerReading: 14,
    frameGapMs: 70
  };

  // ---------- Color math (sRGB D65 -> CIELAB) ----------
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function unlin(c) { var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(v * 255))); }
  var LIN = new Float32Array(256);
  for (var li = 0; li < 256; li++) LIN[li] = lin(li);

  function rgbToLab(r, g, b) {
    var R = LIN[r], G = LIN[g], B = LIN[b];
    var x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    var y = (0.2126 * R + 0.7152 * G + 0.0722 * B);
    var z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToRgb(L, a, b) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    function inv(t) { return t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787; }
    var x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    var R = 3.2406 * x - 1.5372 * y - 0.4986 * z;
    var G = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    var B = 0.0557 * x - 0.2040 * y + 1.0570 * z;
    return [unlin(R), unlin(G), unlin(B)];
  }
  function parseRgb(s) {
    var m = String(s).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function median(arr) {
    var s = arr.slice().sort(function (p, q) { return p - q; });
    var n = s.length; if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function dist(p, q) {
    var dL = (p[0] - q[0]) * SETTINGS.weightL, da = (p[1] - q[1]) * SETTINGS.weightAB, db = (p[2] - q[2]) * SETTINGS.weightAB;
    return Math.sqrt(dL * dL + da * da + db * db);
  }
  function deltaE(p, q) {
    var dL = p[0] - q[0], da = p[1] - q[1], db = p[2] - q[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  // Sample spots, as fractions of the camera frame shown on screen.
  var ZONES = [
    { name: "forehead", x: 0.50, y: 0.30, r: 0.055 },
    { name: "left", x: 0.37, y: 0.53, r: 0.06 },
    { name: "right", x: 0.63, y: 0.53, r: 0.06 }
  ];
  var CW = 240, CH = 320; // analysis canvas, 3:4 like the viewfinder

  // Reads one frame. Returns per-zone Lab colors plus lighting stats.
  function analyzeFrame(ctx) {
    var img = ctx.getImageData(0, 0, CW, CH).data;
    var frameSum = 0, frameCount = 0;
    for (var p = 0; p < img.length; p += 16) { frameSum += (img[p] + img[p + 1] + img[p + 2]) / 3; frameCount++; }
    var zones = [], clipped = 0, total = 0;
    for (var zi = 0; zi < ZONES.length; zi++) {
      var z = ZONES[zi], cx = z.x * CW, cy = z.y * CH, rad = z.r * CW, r2 = rad * rad;
      var labs = [];
      for (var y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
        for (var x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
          var i = (y * CW + x) * 4, r = img[i], g = img[i + 1], b = img[i + 2];
          total++;
          if (r >= 253 || g >= 253 || b >= 253) { clipped++; continue; }
          labs.push(rgbToLab(r, g, b));
        }
      }
      // Drop the brightest and darkest fifth (shine, shadows, stray hair).
      labs.sort(function (p1, p2) { return p1[0] - p2[0]; });
      var lo = Math.floor(labs.length * 0.2), hi = Math.ceil(labs.length * 0.8), sL = 0, sa = 0, sb = 0, n = 0;
      for (var k = lo; k < hi; k++) { sL += labs[k][0]; sa += labs[k][1]; sb += labs[k][2]; n++; }
      zones.push(n ? [sL / n, sa / n, sb / n] : null);
    }
    return { zones: zones, frameMean: frameSum / frameCount, clippedShare: total ? clipped / total : 0 };
  }

  // Combines frames and flags anything that makes the reading unreliable.
  function combine(frames) {
    var perZone = ZONES.map(function (_, zi) {
      var L = [], a = [], b = [];
      frames.forEach(function (f) { var z = f.zones[zi]; if (z) { L.push(z[0]); a.push(z[1]); b.push(z[2]); } });
      return L.length ? [median(L), median(a), median(b)] : null;
    });
    var frameMean = median(frames.map(function (f) { return f.frameMean; }));
    var clippedShare = median(frames.map(function (f) { return f.clippedShare; }));
    var issue = null;
    if (perZone.some(function (z) { return !z; })) issue = "glare";
    else if (frameMean < 38) issue = "dark";
    else if (clippedShare > 0.25) issue = "glare";
    else {
      var looksLikeSkin = perZone.every(function (z) {
        var hue = Math.atan2(z[2], z[1]) * 180 / Math.PI, chroma = Math.sqrt(z[1] * z[1] + z[2] * z[2]);
        return z[1] > -2 && hue > 5 && hue < 105 && chroma > 3;
      });
      var spread = Math.max(deltaE(perZone[0], perZone[1]), deltaE(perZone[0], perZone[2]), deltaE(perZone[1], perZone[2]));
      if (!looksLikeSkin || spread > 26) issue = "center";
      else if (Math.abs(perZone[1][0] - perZone[2][0]) > 11) issue = "uneven";
    }
    var color = null;
    if (perZone.every(Boolean)) {
      color = [0, 1, 2].map(function (c) { return median(perZone.map(function (z) { return z[c]; })); });
    }
    return { color: color, issue: issue };
  }

  function rank(color, shades) {
    var probe = [color[0] + SETTINGS.lightnessOffset, color[1], color[2]];
    return shades.map(function (s) { return { shade: s, d: dist(probe, s.lab) }; })
      .sort(function (p, q) { return p.d - q.d; });
  }

  var MESSAGES = {
    dark: "It's too dark to read your shade. Face a window or a bright lamp.",
    glare: "Too much glare on your skin. Step back from the light or tilt your phone slightly.",
    center: "Fit your face inside the oval, with the three dots on your forehead and cheeks.",
    uneven: "One side of your face is in shadow. Turn so the light hits your face straight on.",
    ok: "Looks good. Hold still and take your reading."
  };

  // ---------- Styles ----------
  var CSS = "" +
    ".sf-open{font:inherit;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;margin:2px 0 4px;padding:9px 14px;border-radius:999px;border:1px solid var(--espresso,#261000);background:transparent;color:var(--espresso,#261000);cursor:pointer;justify-self:start}" +
    ".sf-open[hidden]{display:none}" +
    ".sf-open:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-open svg{width:16px;height:16px;flex:none}" +
    ".sf-picked{font-size:12px;color:var(--espresso-soft,#5B4436);margin:0}" +
    "dialog.sf{border:0;padding:0;width:min(440px,100vw);max-width:100vw;max-height:100dvh;border-radius:20px;background:var(--warm-white,#FFFBF7);color:var(--espresso,#261000);font-family:var(--body,Raleway,Arial,sans-serif);box-shadow:0 30px 80px -20px rgba(38,16,0,.6)}" +
    "dialog.sf::backdrop{background:rgba(38,16,0,.6)}" +
    "@media (max-width:480px){dialog.sf{width:100vw;height:100dvh;max-height:100dvh;border-radius:0;margin:0}}" +
    ".sf-body{padding:22px 22px 24px;display:grid;gap:14px}" +
    ".sf-head{display:flex;justify-content:space-between;align-items:center;gap:12px}" +
    ".sf h2{font-family:var(--display,Georgia,serif);font-weight:400;font-size:26px;line-height:1.15;margin:0}" +
    ".sf-x{font:inherit;font-size:24px;line-height:1;border:0;background:transparent;color:var(--espresso,#261000);cursor:pointer;width:40px;height:40px;border-radius:50%;flex:none}" +
    ".sf-x:hover{background:var(--paper,#FFF3E8)}" +
    ".sf p{margin:0;font-size:14px;color:var(--espresso-soft,#5B4436)}" +
    ".sf ul{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:14px}" +
    ".sf li{display:flex;gap:10px;align-items:flex-start}" +
    ".sf li b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--paper,#FFF3E8);color:var(--auburn,#96262C);font-size:12px;display:grid;place-items:center;margin-top:1px}" +
    ".sf-private{display:flex;gap:10px;align-items:flex-start;background:var(--paper,#FFF3E8);border-radius:12px;padding:12px 14px;font-size:13px;color:var(--espresso,#261000)}" +
    ".sf-private svg{width:18px;height:18px;flex:none;margin-top:1px;color:var(--auburn,#96262C)}" +
    ".sf-btn{font:inherit;font-weight:700;font-size:15px;letter-spacing:.03em;border:0;border-radius:999px;padding:14px 20px;cursor:pointer;background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7);width:100%}" +
    ".sf-btn:hover{background:var(--auburn,#96262C)}" +
    ".sf-btn[disabled]{opacity:.6;cursor:default}" +
    ".sf-btn.ghost{background:transparent;color:var(--espresso,#261000);border:1px solid var(--espresso,#261000)}" +
    ".sf-btn.ghost:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    ".sf-view{position:relative;width:100%;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#1a0b00}" +
    ".sf-view video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}" +
    ".sf-view svg{position:absolute;inset:0;width:100%;height:100%}" +
    ".sf-status{position:absolute;left:12px;right:12px;bottom:12px;background:rgba(38,16,0,.78);color:#FFFBF7;font-size:13px;line-height:1.4;padding:10px 12px;border-radius:12px;text-align:center}" +
    ".sf-status.ok{background:rgba(38,16,0,.78);box-shadow:inset 0 0 0 1.5px var(--gold,#E4A524)}" +
    ".sf-result{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;background:var(--paper,#FFF3E8);border-radius:16px;padding:16px}" +
    ".sf-dots{display:flex}" +
    ".sf-dots i{width:58px;height:58px;border-radius:50%;display:block;border:3px solid var(--warm-white,#FFFBF7);box-shadow:0 0 0 1px rgba(38,16,0,.12)}" +
    ".sf-dots i+i{margin-left:-14px}" +
    ".sf-result small{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--burnt-orange,#AB5B1E)}" +
    ".sf-result strong{display:block;font-family:var(--display,Georgia,serif);font-weight:400;font-size:28px;line-height:1.1;color:var(--espresso,#261000)}" +
    ".sf-legend{display:flex;gap:14px;font-size:12px;color:var(--espresso-soft,#5B4436)}" +
    ".sf-legend span{display:flex;align-items:center;gap:6px}" +
    ".sf-legend i{width:12px;height:12px;border-radius:50%;display:block;border:1px solid rgba(38,16,0,.15)}" +
    ".sf-alt{display:flex;align-items:center;gap:10px;font-size:14px}" +
    ".sf-alt i{width:24px;height:24px;border-radius:50%;display:block;border:1px solid rgba(38,16,0,.15);flex:none}" +
    ".sf-alt button{font:inherit;font-weight:600;font-size:14px;color:var(--auburn,#96262C);background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}" +
    ".sf-link{font:inherit;font-size:14px;font-weight:600;color:var(--espresso,#261000);background:none;border:0;padding:6px 0;text-decoration:underline;text-underline-offset:3px;cursor:pointer;justify-self:center}" +
    ".sf [hidden]{display:none !important}";

  var ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  var ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function setup(trigger) {
    var groupName = trigger.getAttribute("data-shade-finder");
    var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + groupName + '"]'));
    var shades = radios.filter(function (r) { return r.value !== "prefer_not"; }).map(function (r) {
      var label = r.closest("label"), sw = label && label.querySelector("i");
      var rgb = sw && parseRgb(getComputedStyle(sw).backgroundColor);
      return rgb ? { input: r, name: label.textContent.trim(), rgb: rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) } : null;
    }).filter(Boolean);
    if (shades.length < 2) return;

    var canUseCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
    trigger.hidden = false;

    var picked = document.getElementById(trigger.getAttribute("aria-describedby") || "") || null;

    var dlg = el("dialog", { "class": "sf", "aria-labelledby": "sfTitle" });
    dlg.innerHTML =
      '<div class="sf-body">' +
        '<div class="sf-head"><h2 id="sfTitle">Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +

        '<div data-step="intro" class="sf-body" style="padding:0">' +
          '<p>Your phone camera can suggest the closest of the ten shades. It takes about ten seconds.</p>' +
          '<ul>' +
            '<li><b>1</b><span>Face a window or bright light, so your whole face is lit evenly.</span></li>' +
            '<li><b>2</b><span>Go bare-faced if you can. Makeup and filters change the reading.</span></li>' +
            '<li><b>3</b><span>Hold your phone at arm\'s length, eye level, and fit your face in the oval.</span></li>' +
          '</ul>' +
          '<div class="sf-private">' + ICON_LOCK + '<span>Your camera image stays on your phone. Pulse never saves, uploads or sees it. Only the shade you choose is sent.</span></div>' +
          '<button type="button" class="sf-btn" data-start>Start Camera</button>' +
        '</div>' +

        '<div data-step="camera" hidden class="sf-body" style="padding:0">' +
          '<div class="sf-view">' +
            '<video playsinline muted autoplay></video>' +
            '<svg viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">' +
              '<defs><mask id="sfMask"><rect width="300" height="400" fill="#fff"/><ellipse cx="150" cy="176" rx="96" ry="132" fill="#000"/></mask></defs>' +
              '<rect width="300" height="400" fill="rgba(38,16,0,.45)" mask="url(#sfMask)"/>' +
              '<ellipse cx="150" cy="176" rx="96" ry="132" fill="none" stroke="#FFFBF7" stroke-width="2" stroke-dasharray="6 6"/>' +
              ZONES.map(function (z) { return '<circle cx="' + z.x * 300 + '" cy="' + z.y * 400 + '" r="' + z.r * 300 + '" fill="none" stroke="#E4A524" stroke-width="2"/>'; }).join("") +
            '</svg>' +
            '<div class="sf-status" role="status" aria-live="polite">Starting camera…</div>' +
          '</div>' +
          '<button type="button" class="sf-btn" data-capture disabled>Take Reading</button>' +
        '</div>' +

        '<div data-step="result" hidden class="sf-body" style="padding:0">' +
          '<div class="sf-result">' +
            '<div class="sf-dots"><i data-measured title="What the camera saw"></i><i data-best-dot></i></div>' +
            '<div><small>Closest Shade</small><strong data-best-name></strong></div>' +
          '</div>' +
          '<div class="sf-legend"><span><i data-measured-key></i>What the camera saw</span><span><i data-best-key></i><span data-best-key-name></span></span></div>' +
          '<p data-note></p>' +
          '<div class="sf-alt" data-alt-row><i data-alt-dot></i><span>Also close: <button type="button" data-use-alt></button></span></div>' +
          '<button type="button" class="sf-btn" data-use-best></button>' +
          '<div class="sf-row"><button type="button" class="sf-btn ghost" data-retry>Try Again</button><button type="button" class="sf-btn ghost" data-close>Pick Myself</button></div>' +
        '</div>' +

        '<div data-step="error" hidden class="sf-body" style="padding:0">' +
          '<p data-error></p>' +
          '<p>You can still pick by eye. In daylight, hold your phone next to your jawline in a mirror and choose the shade that blends in best.</p>' +
          '<button type="button" class="sf-btn" data-close>Pick Myself</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    var q = function (s) { return dlg.querySelector(s); };
    var video = q("video"), status = q(".sf-status"), captureBtn = q("[data-capture]");
    var canvas = document.createElement("canvas"); canvas.width = CW; canvas.height = CH;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var stream = null, liveTimer = null, busy = false, ranked = null, focusAfter = null;

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
      // Match object-fit: cover, so the dots line up with what's on screen.
      var target = CW / CH, sw = vw, sh = vh, sx = 0, sy = 0;
      if (vw / vh > target) { sw = vh * target; sx = (vw - sw) / 2; } else { sh = vw / target; sy = (vh - sh) / 2; }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, CW, CH);
      return true;
    }
    function setStatus(issue) {
      status.textContent = MESSAGES[issue || "ok"];
      status.classList.toggle("ok", !issue);
    }
    function liveCheck() {
      if (busy || !grab()) return;
      setStatus(combine([analyzeFrame(ctx)]).issue);
    }

    function startCamera() {
      show("camera");
      status.textContent = "Starting camera…"; status.classList.remove("ok");
      captureBtn.disabled = true;
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }
      }).then(function (s) {
        stream = s;
        video.srcObject = s;
        var p = video.play(); if (p && p.catch) p.catch(function () {});
        video.onloadedmetadata = function () {
          captureBtn.disabled = false;
          // Give auto-exposure a moment to settle before judging the light.
          setTimeout(liveCheck, 600);
          liveTimer = setInterval(liveCheck, 700);
        };
      }).catch(function (e) {
        var inApp = /Instagram|FBAN|FBAV|TikTok|Snapchat|Line\//i.test(navigator.userAgent);
        var msg;
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
          msg = inApp
            ? "This app's built-in browser blocked the camera. Tap the menu (•••) and choose Open in Browser, then try again."
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
      if (busy) return;
      busy = true; captureBtn.disabled = true;
      status.textContent = "Reading… hold still."; status.classList.add("ok");
      var frames = [];
      (function next() {
        if (!stream) { busy = false; return; }
        if (grab()) frames.push(analyzeFrame(ctx));
        if (frames.length < SETTINGS.framesPerReading) { setTimeout(next, SETTINGS.frameGapMs); return; }
        busy = false; captureBtn.disabled = false;
        var res = combine(frames);
        if (res.issue || !res.color) { setStatus(res.issue || "center"); return; }
        ranked = rank(res.color, shades);
        stopCamera();
        showResult(res.color);
      })();
    }

    function showResult(color) {
      var best = ranked[0].shade, alt = ranked[1].shade;
      var m = labToRgb(color[0], color[1], color[2]), mCss = "rgb(" + m.join(",") + ")";
      var bCss = "rgb(" + best.rgb.join(",") + ")";
      q("[data-measured]").style.background = mCss;
      q("[data-measured-key]").style.background = mCss;
      q("[data-best-dot]").style.background = bCss;
      q("[data-best-key]").style.background = bCss;
      q("[data-best-key-name]").textContent = best.name;
      q("[data-best-name]").textContent = best.name;
      q("[data-use-best]").textContent = "Use " + best.name;
      var close = ranked[1].d - ranked[0].d < 4;
      q("[data-note]").textContent = close
        ? "You're right between " + best.name + " and " + alt.name + ". Pick whichever looks more like you in daylight."
        : "Cameras and lighting shift color a little. If another shade looks more like you, pick that one instead.";
      q("[data-alt-dot]").style.background = "rgb(" + alt.rgb.join(",") + ")";
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
      ranked = null;
      if (!canUseCamera) {
        q("[data-error]").textContent = window.isSecureContext === false
          ? "The camera only works on the secure (https) version of this page."
          : "This browser doesn't support the camera. Try Safari or Chrome.";
        show("error");
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
      stopCamera();
      document.documentElement.style.overflow = "";
      var target = focusAfter || trigger; focusAfter = null;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
      var lbl = target.closest && target.closest("label");
      if (lbl && lbl.scrollIntoView) lbl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) { close(); return; } // tap on backdrop
      var t = e.target.closest("button"); if (!t) return;
      if (t.hasAttribute("data-close")) close();
      else if (t.hasAttribute("data-start")) startCamera();
      else if (t.hasAttribute("data-capture")) capture();
      else if (t.hasAttribute("data-retry")) startCamera();
      else if (t.hasAttribute("data-use-best")) choose(ranked[0].shade);
      else if (t.hasAttribute("data-use-alt")) choose(ranked[1].shade);
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

  // Exposed for testing the color math.
  window.PulseShadeFinder = { rgbToLab: rgbToLab, labToRgb: labToRgb, combine: combine, rank: rank, analyzeFrame: analyzeFrame, ZONES: ZONES, SETTINGS: SETTINGS };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
