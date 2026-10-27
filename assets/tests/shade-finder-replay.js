/*
 * Replay test for Find My Shade. Paints synthetic camera frames (cheeks, eyes
 * with eye whites, iris, pupil, lash shadow, hooded lids) and runs them through
 * the finder's pixel analysis and fusion, exactly as the browser would, minus
 * the face tracker (landmarks are placed by hand).
 *
 *   node assets/tests/shade-finder-replay.js                 # test the current finder
 *   node assets/tests/shade-finder-replay.js path/to/old.js  # compare against another version
 *
 * The bar: every case lands on the right gemstone or its neighbor, and nothing
 * is ever 3+ gemstones off. Fails (exit 1) otherwise.
 */
"use strict";
var path = require("path");

function loadFinder(file) {
  global.window = {}; global.location = { search: "" };
  global.document = { readyState: "loading", querySelectorAll: function () { return []; }, getElementById: function () { return null; }, currentScript: null, addEventListener: function () {} };
  delete require.cache[require.resolve(path.resolve(__dirname, "../shade-library.js"))];
  delete require.cache[require.resolve(file)];
  require(path.resolve(__dirname, "../shade-library.js"));
  require(file);
  var sf = global.window.PulseShadeFinder, names = global.window.PULSE_SHADES.gemstones.map(function (g) { return g.name; });
  return { sf: sf, names: names, version: sf.VERSION || "3.2" };
}

// ---- synthetic frame ----
var W = 720, H = 960;
function Frame() {
  this.data = new Uint8ClampedArray(W * H * 4);
  this.fill([40, 40, 40]); // dark background
}
Frame.prototype.fill = function (c) { for (var i = 0; i < this.data.length; i += 4) { this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = 255; } };
Frame.prototype.set = function (x, y, c) { if (x < 0 || y < 0 || x >= W || y >= H) return; var i = (y * W + x) * 4; this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = 255; };
Frame.prototype.ellipse = function (cx, cy, rx, ry, c, fn) {
  for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
    var nx = (x - cx) / rx, ny = (y - cy) / ry; if (nx * nx + ny * ny > 1) continue;
    this.set(x, y, fn ? fn(x, y) : c);
  }
};
Frame.prototype.ctx = function () {
  var self = this;
  return { getImageData: function (x0, y0, w, h) {
    if (x0 === 0 && y0 === 0 && w === W && h === H) return { data: self.data };
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * w + x) * 4; out[di] = self.data[si]; out[di + 1] = self.data[si + 1]; out[di + 2] = self.data[si + 2]; out[di + 3] = 255; }
    return { data: out };
  } };
};

// Landmarks used by the finder, placed on a face centered in the frame.
var EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
var EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
var IRIS_L = [468, 469, 470, 471, 472], IRIS_R = [473, 474, 475, 476, 477];
var noise = (function () { var s = 12345; return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff - 0.5); }; })();
function jitter(c, amt) { return c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v + noise() * amt))); }); }

/*
 * opts: skin [r,g,b] as the camera records the cheek; sclera [r,g,b]; iris [r,g,b];
 * open: eye height/width (0.5 = wide, 0.18 = narrow); hooded: 0..1 share of the eye
 * covered by lid skin from the top; lash: shadow band thickness in px; shadeEyes: multiply
 * everything in the eye region by this (eyes in shadow under a brow).
 */
function buildScene(opts) {
  var fr = new Frame();
  if (opts.bg) fr.fill(opts.bg);
  var faceCx = W / 2, faceW = 320; // face spans 44% of frame width
  // Face skin everywhere on the face oval
  fr.ellipse(faceCx, 470, faceW / 2, 230, null, function () { return jitter(opts.skin, 6); });
  var lm = []; for (var i = 0; i < 478; i++) lm.push([faceCx, 470]);
  lm[234] = [faceCx - faceW / 2, 470]; lm[454] = [faceCx + faceW / 2, 470];
  // cheeks
  lm[50] = [faceCx - 95, 520]; lm[280] = [faceCx + 95, 520]; lm[205] = [faceCx - 80, 580]; lm[425] = [faceCx + 80, 580];
  var eyeW = 84, eyeH = eyeW * (opts.open || 0.42), irisR = 19;
  [[faceCx - 85, EYE_L, IRIS_L], [faceCx + 85, EYE_R, IRIS_R]].forEach(function (e) {
    var cx = e[0], cy = 400, shade = opts.shadeEyes || 1;
    var sc = opts.sclera.map(function (v) { return v * shade; }), ir = opts.iris.map(function (v) { return v * shade; });
    // eye outline (16 points, ellipse), corners first like the mesh (index 0 = outer corner, 8 = inner corner)
    e[1].forEach(function (idx, k) { var a = Math.PI * 2 * k / 16; lm[idx] = [cx + Math.cos(a) * eyeW / 2, cy + Math.sin(a) * eyeH / 2]; });
    e[2].forEach(function (idx, k) { lm[idx] = k === 0 ? [cx, cy] : [cx + (k === 1 ? irisR : k === 2 ? -irisR : 0), cy + (k === 3 ? irisR : k === 4 ? -irisR : 0)]; });
    // brow shadow also falls on the skin around the eye (socket), not on the cheek
    if (shade < 1) fr.ellipse(cx, cy + 4, eyeW * 0.75, eyeH * 0.5 + eyeW * 0.3, null, function () { return jitter(opts.skin.map(function (v) { return v * (0.6 + 0.4 * shade); }), 6); });
    // paint: sclera, then iris ring + pupil, then lash shadow bands, then hooded lid
    fr.ellipse(cx, cy, eyeW / 2, eyeH / 2, null, function () { return jitter(sc, 8); });
    fr.ellipse(cx, cy, irisR, irisR, null, function (x, y) { var d = Math.hypot(x - cx, y - cy); return d < irisR * 0.4 ? [8, 6, 6] : jitter(ir, 6); });
    var lash = opts.lash == null ? 2 : opts.lash;
    for (var y = Math.floor(cy - eyeH / 2); y <= Math.ceil(cy + eyeH / 2); y++) for (var x = Math.floor(cx - eyeW / 2); x <= Math.ceil(cx + eyeW / 2); x++) {
      var nx = (x - cx) / (eyeW / 2), ny = (y - cy) / (eyeH / 2); if (nx * nx + ny * ny > 1) continue;
      var edge = 1 - Math.sqrt(nx * nx + ny * ny);
      if (edge * eyeH / 2 < lash) fr.set(x, y, jitter([30, 22, 20], 6)); // lash line / crease shadow all around the rim
      if (opts.hooded && ny < -1 + 2 * Math.min(0.3, opts.hooded)) fr.set(x, y, jitter(opts.skin.map(function (v) { return v * 0.8; }), 6)); // lid skin covering the top
    }
  });
  return { frame: fr, lm: lm };
}

function runCase(F, c) {
  var sc = buildScene(c), ctx = sc.frame.ctx();
  var frames = [];
  for (var i = 0; i < 8; i++) frames.push(F.sf.analyzeFrame(ctx, W, H, sc.lm, { ctx: ctx, scale: 1 }));
  var res = F.sf.combine(frames);
  if (res.issue) return { refused: res.issue };
  var cl = F.sf.classify(res.depth, res.deeperThan, res.between);
  return { gem: cl.best, alt: cl.alt, between: cl.between, depth: res.depth, source: res.source || "eyes", eye: res.eyeDepth, color: res.colorDepth, range: res.range, iris: res.irisRatio, warm: res.irisWarm, bright: res.eyeBright, under: res.underEye };
}

// ---- a phone camera, roughly ----
// Scenes are defined by TRUE reflectances (linear RGB). The camera then
// auto-exposes on the face, applies a shadow-lifting tone curve (phones brighten
// dark faces and compress highlights) and encodes to sRGB. This is what makes a
// deep face and its eye whites sit closer together in the photo than in life.
function srgbEnc(v) { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
var cameraBg = 0.2;
function makeCamera(faceRefl, opts) {
  opts = opts || {};
  var y = 0.2126 * faceRefl[0] + 0.7152 * faceRefl[1] + 0.0722 * faceRefl[2];
  // auto-exposure: the camera meters the whole frame (face ~40%, room ~60% at
  // 0.2 reflectance) to 18% gray, so a deep face stays darker than a light one,
  // just less so than in life
  var bg = opts.bg == null ? 0.2 : opts.bg;
  var gain = (opts.aeTarget || 0.18) / (0.4 * y + 0.6 * bg);
  cameraBg = bg;
  var lift = opts.lift == null ? 0.82 : opts.lift;        // tone curve exponent < 1 lifts shadows, compresses highlights
  var wb = opts.wb || [1, 1, 1];                          // illuminant tint the camera failed to remove
  return function (refl) {
    return [0, 1, 2].map(function (c) { var v = refl[c] * gain * wb[c]; return srgbEnc(Math.pow(Math.min(1, v), lift)); });
  };
}
// True skin reflectances: the median library shade of each gemstone (assets/shade-library.js, sRGB -> linear).
function libSkin(gem) {
  var rows = global.window.PULSE_SHADES.shades.filter(function (s) { return s[6] === gem; });
  rows.sort(function (a, b) { return a[5] - b[5]; });
  var h = rows[rows.length >> 1][4];
  return [1, 3, 5].map(function (i) { return lin(parseInt(h.slice(i, i + 2), 16)); });
}
// Eye whites: 0.34 was calibrated as what the camera sees of a clean sclera (lids shade it).
var SCLERA_CLEAN = [0.36, 0.34, 0.31], SCLERA_PIGMENT = [0.21, 0.17, 0.14];
var IRIS_DARK = [0.055, 0.040, 0.035], IRIS_LIGHT = [0.14, 0.16, 0.19];

// name, expected gemstone (0 Pearl .. 9 Onyx), true scene, camera options
var CASES = [
  ["Onyx, clean eye whites, wide eyes", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK }],
  ["Onyx, pigmented eye whites", 9, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK }],
  ["Onyx, hooded eyes (60% lid)", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, hooded: 0.6, open: 0.3 }],
  ["Onyx, narrow eyes, heavy lashes", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, open: 0.2, lash: 3 }],
  ["Onyx, eyes nearly shut (should ask)", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, open: 0.16, lash: 5 }],
  ["Onyx, eyes in brow shadow (hard, should ask)", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, shadeEyes: 0.5 }],
  ["Onyx, eyes in light brow shadow", 9, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, shadeEyes: 0.8 }],
  ["Onyx, hooded + pigmented + shadow", 9, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK, hooded: 0.5, open: 0.26, shadeEyes: 0.7, lash: 3 }],
  ["Onyx, strong shadow lift, warm light", 9, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK }, { lift: 0.7, wb: [1.1, 1, 0.85] }],
  ["Obsidian, clean", 8, { sclera: SCLERA_CLEAN, iris: IRIS_DARK }],
  ["Obsidian, hooded + pigmented", 8, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK, hooded: 0.55, open: 0.28 }],
  ["Smoky Quartz, eyes in light shadow", 7, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, shadeEyes: 0.8 }],
  ["Smoky Quartz, cool light", 7, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK }, { wb: [0.92, 1, 1.12] }],
  ["Bronzite, narrow eyes", 6, { sclera: SCLERA_PIGMENT, iris: IRIS_DARK, open: 0.2, lash: 3 }],
  ["Tiger's Eye, clean (calibration person)", 5, { sclera: SCLERA_CLEAN, iris: IRIS_DARK }],
  ["Tiger's Eye, hooded", 5, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, hooded: 0.6, open: 0.3 }],
  ["Amber, eyes in light shadow", 4, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, shadeEyes: 0.8 }],
  ["Citrine, clean", 3, { sclera: SCLERA_CLEAN, iris: IRIS_DARK }],
  ["Moonstone, hooded, light eyes", 2, { sclera: SCLERA_CLEAN, iris: IRIS_LIGHT, hooded: 0.6, open: 0.3 }],
  ["Selenite, clean, light eyes", 1, { sclera: SCLERA_CLEAN, iris: IRIS_LIGHT }],
  ["Pearl, clean, light eyes", 0, { sclera: SCLERA_CLEAN, iris: IRIS_LIGHT }],
  ["Pearl, hooded, dark eyes", 0, { sclera: SCLERA_CLEAN, iris: IRIS_DARK, hooded: 0.6, open: 0.3 }],
  ["Pearl, eyes in light shadow", 0, { sclera: SCLERA_CLEAN, iris: IRIS_LIGHT, shadeEyes: 0.8 }]
];
function sceneFor(c) {
  var skin = libSkin(c[1]), cam = makeCamera(skin, c[3]), s = c[2];
  return { skin: cam(skin), sclera: cam(s.sclera), iris: cam(s.iris), bg: cam([cameraBg, cameraBg, cameraBg]), open: s.open, hooded: s.hooded, lash: s.lash, shadeEyes: s.shadeEyes };
}

function main() {
  var file = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "../shade-finder.js");
  var F = loadFinder(file);
  console.log("Find My Shade v" + F.version + "  (" + path.relative(process.cwd(), file) + ")\n");
  var fails = 0, catastrophic = 0, refused = 0;
  CASES.forEach(function (c) {
    var r = runCase(F, sceneFor(c)), exp = c[1], line = c[0].padEnd(42);
    var shouldAsk = /should ask/.test(c[0]);
    if (r.refused) { if (!shouldAsk) refused++; console.log(line + (shouldAsk ? "asked again (" : "REFUSED (") + r.refused + ")   want " + F.names[exp]); return; }
    if (shouldAsk) { fails++; console.log(line + F.names[r.gem].padEnd(13) + "  should have asked, not guessed"); return; }
    var off = Math.abs(r.gem - exp), okAlt = r.alt === exp;
    var verdict = off === 0 ? "ok" : off === 1 ? (okAlt ? "ok (runner-up)" : "ok (neighbor)") : "WRONG by " + off;
    if (off >= 2) fails++; if (off >= 3) catastrophic++;
    console.log(line + F.names[r.gem].padEnd(13) + (r.between ? "~ " : "  ") + "want " + F.names[exp].padEnd(13) + verdict.padEnd(16) +
      "depth " + r.depth.toFixed(1) + (r.source ? " via " + r.source : "") + (r.eye != null ? " eye " + r.eye.toFixed(0) : "") + (r.color != null ? " color " + r.color.toFixed(0) + "/" + r.range : "") + (r.iris != null ? " skin/iris " + r.iris.toFixed(1) + (r.warm === false ? "(light iris)" : "") : "") + (r.bright != null ? " eyeMax/skin " + r.bright.toFixed(1) : "") + (r.under != null ? " under/cheek " + r.under.toFixed(2) : ""));
  });
  console.log("\n" + CASES.length + " cases: " + (CASES.length - fails - refused) + " on target or neighbor, " + fails + " off by 2+, " + catastrophic + " off by 3+, " + refused + " refused");
  process.exit(fails || refused ? 1 : 0);
}
main();
