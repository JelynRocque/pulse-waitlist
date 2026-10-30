/* Pulse friends-and-family web test. See index.html for what this is.
   Flow: link token → consent → (engine ready) → camera with live checks → analyze in the browser → send scores → results + routine → history.
   Only `analysis` (scores, confidence, quality) ever leaves the phone. Face points (landmarks) are requested only to place
   the heat-map zones on this screen; they stay in memory on the phone and are never sent. */
(function () {
  'use strict';
  var API = window.PULSE_TEST_API || 'https://bgagcxdsqnasgegazusf.supabase.co/functions/v1/webtest';   // Pulse dev project; switch to staging before the first real tester. PULSE_TEST_API: local end-to-end test only
  var CONSENT_VERSION = 'webtest-v1-2026-10-28';
  var TEST_DAYS = 14;
  var $ = function (id) { return document.getElementById(id); };
  var token = null, state = null, history = [], engineReady = false, engineFailed = false;

  // ---------- helpers ----------
  function show(id) { document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('on'); }); $(id).classList.add('on'); document.body.classList.toggle('dark', $(id).classList.contains('dk')); window.scrollTo(0, 0); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function localDate() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayIndex() {
    if (!state || !state.started_on) return 1;
    var s = state.started_on.split('-'), start = new Date(+s[0], +s[1] - 1, +s[2]), now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.max(1, Math.round((now - start) / 86400000) + 1);
  }
  function api(action, body) {
    body = body || {}; body.action = action; if (token) body.t = token;
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'network' }; });
  }
  function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  // ---------- engine bridge (same-origin iframe running the app's engine) ----------
  var pending = {}, seq = 0;
  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data.pulseEngine !== 'string') return;
    var m; try { m = JSON.parse(e.data.pulseEngine); } catch (err) { return; }
    if (m.type === 'ready') { engineReady = true; onEngineReady(); return; }
    if (m.type === 'init_error') { engineFailed = true; onEngineReady(); return; }
    if (m.type === 'result' && m.id && pending[m.id]) { var cb = pending[m.id]; delete pending[m.id]; cb(m); }
  });
  function engineRun(b64, mode, wantLandmarks) {
    return new Promise(function (resolve) {
      if (!engineReady) return resolve({ ok: false, error: engineFailed ? 'engine_unavailable' : 'engine_loading' });
      var id = 'j' + (++seq); pending[id] = resolve;
      var t = setTimeout(function () { if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'timeout' }); } }, 30000);
      pending[id] = function (r) { clearTimeout(t); resolve(r); };
      try { $('engine').contentWindow.__pulse({ id: id, b64: b64, mode: mode, wantLandmarks: !!wantLandmarks }); }
      catch (err) { delete pending[id]; clearTimeout(t); resolve({ ok: false, error: 'engine_unavailable' }); }
    });
  }
  function onEngineReady() {
    var st = $('engine-status');
    if (engineFailed) { st.innerHTML = 'The analysis engine could not load on this browser. Try Safari on iPhone or Chrome on Android, on Wi-Fi.'; return; }
    st.hidden = true; $('home-scan').disabled = false;
  }

  // ---------- consent ----------
  // The hash stored with the consent covers the notice and both checkbox texts, so a later wording change is detectable.
  function noticeText() {
    var parts = [$('notice-text')].concat(Array.prototype.slice.call(document.querySelectorAll('#s-consent .check')));
    return CONSENT_VERSION + '\n' + parts.map(function (el) { return el.innerText.replace(/\s+/g, ' ').trim(); }).join('\n');
  }
  $('c-agree').addEventListener('click', function () {
    var err = $('c-err'); err.hidden = true;
    var name = $('c-name').value.trim();
    if (!$('c-main').checked) { err.textContent = 'Tick the first box to continue, or choose Not now.'; err.hidden = false; return; }
    if (name.length < 2 || name.indexOf(' ') < 0) { err.textContent = 'Type your full name (first and last).'; err.hidden = false; return; }
    $('c-agree').disabled = true;
    sha256(noticeText()).then(function (h) {
      return api('consent', { version: CONSENT_VERSION, text_hash: h, name: name, keep_photos: $('c-photos').checked });
    }).then(function (r) {
      $('c-agree').disabled = false;
      if (!r.ok) { err.textContent = r.error === 'withdrawn' ? 'This link was withdrawn.' : 'Something went wrong. Check your connection and try again.'; err.hidden = false; return; }
      state = r; renderHome();
    });
  });
  $('c-notnow').addEventListener('click', function () { show('s-gate'); $('relink').hidden = true; $('relink-done').hidden = true; });

  // ---------- home + history ----------
  function renderHome() {
    var d = dayIndex();
    $('withdraw-row').hidden = false;
    if (d > TEST_DAYS) { $('ended-history').innerHTML = historyHtml(); show('s-ended'); return; }
    $('home-day').textContent = 'Day ' + d + ' of ' + TEST_DAYS;
    var today = history.filter(function (s) { return s.date === localDate(); }).length;
    $('home-title').textContent = today ? (today === 1 && d === 1 ? 'One more scan today?' : 'Scanned today. Come back tomorrow.') : "Ready for today's scan?";
    $('home-sub').textContent = today === 1 && d === 1 ? 'A second scan straight after the first shows how steady the reading is.' : 'Face a window or a lamp, no hat or glasses, phone at eye level. Daylight is best.';
    $('home-history').innerHTML = historyHtml();
    show('s-home');
  }
  function historyHtml() {
    if (!history.length) return '<p class="muted" style="margin-top:20px">Your 14-day line appears here after your first scan.</p>';
    var pts = history.filter(function (s) { return s.skin_score != null; });
    var w = 520, h = 160, pad = 28, maxD = TEST_DAYS;
    var x = function (day) { return pad + (day - 1) / (maxD - 1) * (w - 2 * pad); }, y = function (v) { return h - pad - v / 100 * (h - 2 * pad); };
    var path = pts.map(function (s, i) { return (i ? 'L' : 'M') + x(s.day).toFixed(1) + ' ' + y(s.skin_score).toFixed(1); }).join(' ');
    var dots = pts.map(function (s) { return '<circle cx="' + x(s.day).toFixed(1) + '" cy="' + y(s.skin_score).toFixed(1) + '" r="4" fill="#882E1A"/>'; }).join('');
    var grid = [25, 50, 75].map(function (v) { return '<line x1="' + pad + '" x2="' + (w - pad) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#E7D6C8"/><text x="4" y="' + (y(v) + 4) + '" font-size="10" fill="#5B4436">' + v + '</text>'; }).join('');
    var days = [1, 7, 14].map(function (d) { return '<text x="' + x(d) + '" y="' + (h - 8) + '" font-size="10" text-anchor="middle" fill="#5B4436">Day ' + d + '</text>'; }).join('');
    var svg = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Skin score by day">' + grid + days + '<path d="' + path + '" fill="none" stroke="#882E1A" stroke-width="2"/>' + dots + '</svg>';
    var rows = history.slice().reverse().slice(0, 14).map(function (s) {
      return '<tr><td>Day ' + s.day + '</td><td>' + esc(s.date) + '</td><td>' + (s.skin_score == null ? '—' : s.skin_score) + '</td><td class="muted">' + (s.issues && s.issues.length ? esc(s.issues.map(issueWord).join(', ')) : '') + '</td></tr>';
    }).join('');
    return '<h2>Your line</h2>' + svg + '<table class="history"><tr><th>Day</th><th>Date</th><th>Score</th><th>Notes</th></tr>' + rows + '</table>';
  }
  var ISSUE_WORD = { small: 'too far', turned: 'turned', dark: 'dark', bright: 'bright', side_light: 'side light', blurry: 'blurry', noface: 'no face' };
  function issueWord(i) { return ISSUE_WORD[i] || i; }

  // ---------- camera ----------
  var stream = null, checkTimer = null, okStreak = 0, shooting = false;
  var TIP = {
    noface: 'Fit your face inside the oval.', small: 'Move a little closer so your face fills the oval.', turned: 'Look straight at the camera, chin level.',
    dark: 'Too dark. Face a window or turn on a lamp in front of you.', bright: 'Too bright. Step out of direct sun or harsh light.',
    side_light: 'Light is hitting one side of your face. Turn to face the light.', blurry: 'Hold still for a moment.',
  };
  $('home-scan').addEventListener('click', startCamera);
  $('r-again-btn').addEventListener('click', startCamera);
  $('cam-cancel').addEventListener('click', function () { stopCamera(); renderHome(); });
  function startCamera() {
    show('s-cam'); okStreak = 0; shooting = false; $('cam-shoot').disabled = true; $('guide').classList.remove('ok'); $('count').textContent = '';
    $('tip').className = 'tip'; $('tip').textContent = 'Starting the camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('tip').textContent = 'This browser cannot use the camera. Try Safari on iPhone or Chrome on Android.'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false }).then(function (s) {
      stream = s; $('video').srcObject = s;
      return $('video').play().catch(function () {});
    }).then(function () { checkTimer = setInterval(liveCheck, 900); })
      .catch(function () { $('tip').textContent = 'Camera access is off. Allow the camera for pulseskin.co in your browser settings, then try again.'; });
  }
  function stopCamera() { clearInterval(checkTimer); checkTimer = null; if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; } }
  function frame(maxSide, quality) {
    var v = $('video'); if (!v.videoWidth) return null;
    var sc = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    var c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality).split(',')[1];
  }
  var checking = false;
  function liveCheck() {
    if (checking || shooting || !engineReady) return;
    var b64 = frame(640, 0.85); if (!b64) return;
    checking = true;
    engineRun(b64, 'check').then(function (r) {
      checking = false; if (shooting) return;
      var issues = !r.ok ? [] : !r.face ? ['noface'] : (r.quality.issues || []);
      var tip = $('tip');
      if (issues.length) { okStreak = 0; tip.className = 'tip'; tip.textContent = TIP[issues[0]] || 'Adjust and hold still.'; $('guide').classList.remove('ok'); $('cam-shoot').disabled = true; }
      else { okStreak++; tip.className = 'tip ok'; tip.textContent = okStreak >= 2 ? 'Looks good. Hold still…' : 'Looks good.'; $('guide').classList.add('ok'); $('cam-shoot').disabled = false; if (okStreak >= 2) shoot(); }
    });
  }
  $('cam-shoot').addEventListener('click', shoot);
  function shoot() {
    if (shooting) return; shooting = true; $('cam-shoot').disabled = true;
    var n = 3; $('count').textContent = n;
    var iv = setInterval(function () {
      n--; if (n > 0) { $('count').textContent = n; return; }
      clearInterval(iv); $('count').textContent = '';
      var b64 = frame(1024, 0.92); stopCamera();
      if (!b64) { renderHome(); return; }
      analyze(b64);
    }, 700);
  }

  // ---------- analyze + save ----------
  function analyze(b64) {
    startBusy(b64);
    var fail = function (msg) { stopBusy(); alert(msg); renderHome(); };
    // A quick face-points pass places the zones for the sweep; then the full read. Face points stay on the phone.
    engineRun(b64, 'check', true).then(function (c) {
      if (c && c.ok && c.face) busyZones(c.landmarks, c.width, c.height);
      return engineRun(b64, 'analyze', true);
    }).then(function (r) {
      if (!r.ok || !r.face || !r.analysis) return fail(!r.ok ? 'The engine could not read that photo. Try again in better light.' : 'No face found. Try again, closer to the camera.');
      var a = r.analysis;
      var body = { local_date: localDate(), result: { model_version: a.model_version, skin_score: a.skin_score, skin_type: a.skin_type, confidence: a.confidence, concerns: a.concerns, quality: a.quality, lighting_signature: a.lighting_signature } };
      if (state && state.keep_photos) body.photo_b64 = b64;
      Promise.all([api('scan', body), busyDone()]).then(function (out) {
        var res = out[0]; stopBusy();
        if (!res.ok) { alert('Your reading could not be saved (' + (res.error || 'network') + '). It is shown below but will not count.'); }
        else history.push({ id: res.scan_id, date: localDate(), day: res.day_index, skin_score: a.skin_score, concerns: a.concerns, not_measured: a.quality.not_measured || [], issues: a.quality.issues || [] });
        var day = res.ok ? res.day_index : dayIndex();
        renderResult(a, day);
        if (!renderMap(a, r, b64, day)) show('s-result');
      });
    });
  }

  // ---------- results ----------
  var NAME = { spots: 'Dark spots & uneven tone', redness: 'Redness', oiliness: 'Shine', texture: 'Texture', pores: 'Pores', acne: 'Breakouts', dark_circles: 'Dark circles', radiance: 'Radiance' };
  var ORDER = ['spots', 'redness', 'oiliness', 'texture', 'pores', 'acne', 'dark_circles', 'radiance'];
  var NM_WHY = { acne: 'the photo was too grainy to tell a breakout from grain', pores: 'the photo was too grainy or soft to see pores', texture: 'the photo was too soft to read texture', dark_circles: 'the under-eye was too shadowed to read', redness: 'the lighting color made redness unreliable', oiliness: 'the light was too bright to read shine', spots: 'not enough confidence in this photo', radiance: 'not enough confidence in this photo' };
  function band(v) { return v < 50 ? ['focus', 'Needs focus'] : v < 70 ? ['watch', 'Watch'] : ['good', 'Doing well']; }
  function renderResult(a, day) {
    $('r-day').textContent = 'Day ' + day + ' of ' + TEST_DAYS;
    var nm = a.quality.not_measured || [];
    $('r-note').textContent = (a.status === 'low_confidence' ? 'Low-confidence reading (' + (TIP[a.reason] ? TIP[a.reason].replace(/\.$/, '').toLowerCase() : a.reason) + '). Scores still count, but a rescan in better light is worth it. ' : '')
      + (a.skin_type ? 'Skin reads as ' + a.skin_type + ' today.' : '');
    var by = {}; a.concerns.forEach(function (c) { by[c.concern] = c; });
    var regions = {}; ((a.overlay_map && a.overlay_map.regions) || []).forEach(function (g) { if (g.zone && Z_ANCHORS[g.zone]) (regions[g.concern] = regions[g.concern] || {})[g.zone] = g.intensity; });
    var where = {}; (a.concerns || []).forEach(function (c) { if (CHIP[c.concern]) where[c.concern] = heatSummary(c.concern, heatFor(c.concern, c.score, regions)); });
    lastRead = { by: by, nm: nm, where: where };
    $('r-hero-ring').innerHTML = ringSvg(a.skin_score, 140, 62, 9, '#F2B95C', 14) + '<span class="big"><b>' + a.skin_score + '</b><small>OF 100</small></span>';
    var scored = ORDER.filter(function (k) { return by[k]; }).sort(function (p, q) { return by[p].score - by[q].score; });
    var focus = scored.filter(function (k) { return by[k].score < 70; }), well = scored.filter(function (k) { return by[k].score >= 70; });
    var skipped = ORDER.filter(function (k) { return !by[k]; });
    $('r-hero-sub').textContent = focus.length ? 'Higher is better. ' + (focus.length === 1 ? 'One measure' : ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][focus.length - 2] + ' measures') + ' to focus on first.' : 'Higher is better. Every measure is doing well today.';
    var tile = function (k) { var v = by[k].score, b = bandOf(v); return '<button type="button" class="tile" data-learn="' + k + '" aria-label="' + CHIP[k] + ' ' + v + ', ' + b.word + '. Learn more"><span class="ti" aria-hidden="true">i</span><span class="tring">' + ringSvg(v, 98, 40, 7, b.col, 6 + Math.floor(v / 10)) + '<b>' + v + '</b></span><span class="tname">' + CHIP[k] + '</span><span class="tband" style="color:' + b.col + '">' + b.word + '</span></button>'; };
    var skipTile = function (k) { return '<button type="button" class="tile nm" data-learn="' + k + '" aria-label="' + CHIP[k] + ', not measured. Learn more"><span class="ti" aria-hidden="true">i</span><span class="tring">' + ringSvg(0, 98, 40, 7, 'rgba(255,246,234,.3)', 0) + '<b>–</b></span><span class="tname">' + CHIP[k] + '</span><span class="tband">' + (nm.indexOf(k) >= 0 ? 'Skipped: ' + NM_WHY[k] : 'Not measured') + '</span></button>'; };
    $('r-focus-wrap').hidden = !focus.length; $('r-focus').innerHTML = focus.map(tile).join('');
    $('r-well-wrap').hidden = !well.length; $('r-well').innerHTML = well.map(tile).join('');
    $('r-skip-wrap').hidden = !skipped.length; $('r-skip').innerHTML = skipped.map(skipTile).join('');
    var plan = routinePlan(a);
    $('r-am').innerHTML = plan.steps.filter(function (s) { return s.period === 'am'; }).map(stepHtml).join('');
    $('r-pm').innerHTML = plan.steps.filter(function (s) { return s.period === 'pm'; }).map(stepHtml).join('');
    $('r-cautions').innerHTML = plan.cautions.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
    var firstDayScans = history.filter(function (s) { return s.day === 1; }).length;
    $('r-again').hidden = !(day === 1 && firstDayScans === 1);
  }
  function stepHtml(s) {
    return '<div class="step"><div class="l">' + esc(s.label) + '</div><div class="f">' + esc(frequency(s)) + (s.ingredients.length ? ' · ' + esc(s.ingredients.join(', ')) : '') + '</div><p class="w">' + esc(s.why) + '</p>' + (s.caution ? '<p class="c">' + esc(s.caution) + '</p>' : '') + '</div>';
  }
  function frequency(s) {
    var when = s.period === 'am' ? 'morning' : 'night';
    if (s.per_week === 0) return 'Paused for 2 weeks';
    var n = function (k) { return k === 1 ? 'Once' : k === 2 ? 'Twice' : k + ' times'; };
    var target = s.per_week >= 7 ? 'every ' + when : n(s.per_week).toLowerCase();
    if (s.start_per_week < s.per_week) return n(s.start_per_week) + ' a week, then ' + target;
    return s.per_week >= 7 ? 'Every ' + when : n(s.per_week) + ' a week';
  }
  $('r-home').addEventListener('click', renderHome);

  // ---------- skin map (heat map) + scan animation ----------
  // Ported from the app (pulse-app/src/lib/face-core.ts zonesFor/superellipse/heatFor/heatSummary and
  // components/FaceOverlay.tsx): zones are placed from the face points, lit with one champagne-gold glow whose
  // intensity carries severity, traced with a faint dotted outline, with a glass label beside the strongest zone.
  // Nothing anatomical is drawn (no mesh, landmark dots or face outline). Photos are shown mirrored, like the
  // camera preview. Layout follows the approved mockups (Oct 30, 2026): 1A Scan Sweep, 2B Swipe Concerns, 3 Ring Tiles.
  var Z_KEYS = ['forehead', 'tzone', 'underEyeL', 'underEyeR', 'cheekL', 'cheekR', 'chin'];
  var Z_ANCHORS = { forehead: [151, 9, 108, 337, 69, 299], tzone: [168, 6, 197, 195, 5, 4, 1, 98, 327], underEyeL: [228, 229, 230, 231, 117, 118, 119],
    underEyeR: [448, 449, 450, 451, 346, 347, 348], cheekL: [50, 101, 36, 205, 187, 123, 147, 207, 206], cheekR: [280, 330, 266, 425, 411, 352, 376, 427, 426], chin: [175, 199, 200, 171, 396, 208, 428] };
  var Z_PAD = { forehead: [1.3, 1.7, 0.3, 0.12], tzone: [1.6, 1.15, 0.1, 0.2], underEyeL: [1.15, 1.4, 0.12, 0.05], underEyeR: [1.15, 1.4, 0.12, 0.05],
    cheekL: [1.15, 1.2, 0.15, 0.12], cheekR: [1.15, 1.2, 0.15, 0.12], chin: [1.2, 1.35, 0.18, 0.06] };
  var Z_WORD = { forehead: 'forehead', tzone: 'T-zone', underEyeL: 'under-eyes', underEyeR: 'under-eyes', cheekL: 'cheeks', cheekR: 'cheeks', chin: 'chin' };
  var CONCERN_ZONES = { spots: { cheekL: 1, cheekR: 0.9, forehead: 0.6 }, texture: { forehead: 1, chin: 0.75, cheekL: 0.5, cheekR: 0.5 }, pores: { tzone: 1, cheekL: 0.65, cheekR: 0.65 },
    redness: { cheekL: 0.85, cheekR: 0.85, tzone: 0.7 }, acne: { chin: 1, cheekL: 0.7, cheekR: 0.7, forehead: 0.55 }, oiliness: { tzone: 1, forehead: 0.8, chin: 0.5 },
    dark_circles: { underEyeL: 1, underEyeR: 1 }, radiance: { cheekL: 0.8, cheekR: 0.8, forehead: 0.8, chin: 0.6, tzone: 0.6 } };
  var CHIP = { spots: 'Dark Spots', texture: 'Texture', pores: 'Pores', redness: 'Redness', acne: 'Breakouts', oiliness: 'Shine', dark_circles: 'Dark Circles', radiance: 'Radiance' };
  var READ_ORDER = ['spots', 'redness', 'oiliness', 'pores', 'texture', 'acne', 'dark_circles', 'radiance'];
  var PLURAL = { spots: 1, pores: 1, acne: 1, dark_circles: 1 };
  var GLOW = '#F2B95C', G_FOCUS = 0.7, G_WELL = 0.42;
  function bandOf(v) { return v < 50 ? { word: 'Needs Focus', col: '#E0663A' } : v < 70 ? { word: 'Watch', col: '#F0B04A' } : { word: 'Doing Well', col: '#F2D08A' }; }
  function ringSvg(v, size, r, sw, col, glowPx) {
    var c = 2 * Math.PI * r, h = size / 2;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true" style="filter:drop-shadow(0 0 ' + glowPx + 'px ' + col + ')">'
      + '<circle cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke="rgba(255,246,234,.12)" stroke-width="' + sw + '"/>'
      + '<circle cx="' + h + '" cy="' + h + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + (c * v / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 ' + h + ' ' + h + ')"/></svg>';
  }

  function superellipse(c, rx, ry, ax, ay, scale, n) {
    n = n || 48; var p = [];
    for (var i = 0; i < n; i++) {
      var t = 2 * Math.PI * i / n, cs = Math.cos(t), sn = Math.sin(t);
      var u = rx * scale * Math.sign(cs) * Math.pow(Math.abs(cs), 0.6), v = ry * scale * Math.sign(sn) * Math.pow(Math.abs(sn), 0.6);
      p.push([c.x + u * ax.x + v * ay.x, c.y + u * ax.y + v * ay.y]);
    }
    return p;
  }
  function pathOf(pts) { return 'M' + pts.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' L') + ' Z'; }
  function zonePath(q, s) { return pathOf(superellipse(q.c, q.rx, q.ry, q.ax, q.ay, s)); }
  // Zones in pixels of a W×H photo shown mirrored (x → W − x).
  function zonesFor(lm, W, H) {
    var P = function (i) { return { x: (1 - lm[i * 3]) * W, y: lm[i * 3 + 1] * H }; };
    var a = P(263), b = P(33);   // after mirroring, the image-right eye corner sits on the display left
    var eye = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    var ax = { x: (b.x - a.x) / eye, y: (b.y - a.y) / eye }, ay = { x: -ax.y, y: ax.x };
    var out = {};
    Z_KEYS.forEach(function (key) {
      var pts = Z_ANCHORS[key].map(P), c = { x: 0, y: 0 };
      pts.forEach(function (q) { c.x += q.x / pts.length; c.y += q.y / pts.length; });
      var mx = 0, my = 0;
      pts.forEach(function (q) { var dx = q.x - c.x, dy = q.y - c.y; mx = Math.max(mx, Math.abs(dx * ax.x + dy * ax.y)); my = Math.max(my, Math.abs(dx * ay.x + dy * ay.y)); });
      var pd = Z_PAD[key], rx = Math.max(mx * pd[0], pd[2] * eye), ry = Math.max(my * pd[1], pd[3] * eye);
      out[key] = { key: key, c: c, rx: rx, ry: ry, ax: ax, ay: ay };
    });
    out._eye = eye;
    return out;
  }
  function heatFor(concern, score, measured) {
    var m = measured[concern];
    if (m && Object.keys(m).length) {
      var e = Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (p, q) { return q[1] - p[1]; });
      var top = e[0][1] || 1;
      return e.filter(function (x, i) { return i === 0 || x[1] >= Math.max(0.12, top * 0.35); })
        .map(function (x) { return { zone: x[0], weight: x[1] / top, opacity: G_WELL * 0.75 + (G_FOCUS - G_WELL * 0.75) * Math.min(1, x[1]) }; });
    }
    var w = CONCERN_ZONES[concern] || {}, base = score < 70 ? G_FOCUS : G_WELL;
    return Object.keys(w).sort(function (p, q) { return w[q] - w[p]; }).map(function (k) { return { zone: k, weight: w[k], opacity: base * (0.55 + 0.45 * w[k]) }; });
  }
  function joinWords(xs) { return xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function heatSummary(concern, lit) {
    var words = []; lit.forEach(function (l) { var wd = Z_WORD[l.zone]; if (l.weight >= 0.6 && words.indexOf(wd) < 0) words.push(wd); });
    return words.length ? CHIP[concern] + (PLURAL[concern] ? ' show' : ' shows') + ' most on your ' + joinWords(words) + '.' : 'No clear pattern for ' + CHIP[concern].toLowerCase() + ' on this scan.';
  }
  // The photo box crops the photo like CSS object-fit: cover; this maps photo pixels to box pixels.
  function fitBox(box, W, H) { var bw = box.clientWidth, bh = box.clientHeight, s = Math.max(bw / W, bh / H); return { s: s, ox: (bw - W * s) / 2, oy: (bh - H * s) / 2, bw: bw, bh: bh }; }
  function faceLayers(W, H, idp) {
    var vb = 'viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice"';
    return '<svg class="glow" ' + vb + ' aria-hidden="true"><defs><filter id="' + idp + 'h" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="STDH"/></filter>'
      + '<filter id="' + idp + 'c" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="STDC"/></filter></defs><g class="g-glow"></g></svg>'
      + '<svg ' + vb + ' aria-hidden="true"><defs><filter id="' + idp + 's" x="-20%" y="-20%" width="140%" height="140%"><feOffset dx="0" dy="0.5"/><feGaussianBlur stdDeviation="1"/></filter></defs><g class="g-dots"></g></svg>';
  }
  function zoneMarkup(z, lit, W, idp, delayFn) {
    var eye = z._eye, sw = Math.max(1.8, W / 360 * 1.8), gap = (eye * 0.075).toFixed(1), glow = '', dots = '';
    lit.forEach(function (l, i) {
      var q = z[l.zone], d = delayFn ? ' style="animation-delay:' + delayFn(q, i) + '"' : '';
      glow += '<g class="zone"' + d + '><path d="' + zonePath(q, 1.12) + '" fill="' + GLOW + '" fill-opacity="' + (l.opacity * 0.75).toFixed(3) + '" filter="url(#' + idp + 'h)"/>'
        + '<path d="' + zonePath(q, 0.62) + '" fill="' + GLOW + '" fill-opacity="' + Math.min(1, l.opacity * 1.05).toFixed(3) + '" filter="url(#' + idp + 'c)"/></g>';
      var o = zonePath(q, 1);
      dots += '<g class="zone"' + d + '><path d="' + o + '" fill="none" stroke="rgba(30,14,6,.75)" stroke-width="' + (sw * 1.22).toFixed(2) + '" stroke-linecap="round" stroke-dasharray="0.1 ' + gap + '" filter="url(#' + idp + 's)"/>'
        + '<path d="' + o + '" fill="none" stroke="rgba(255,246,234,.85)" stroke-width="' + sw.toFixed(2) + '" stroke-linecap="round" stroke-dasharray="0.1 ' + gap + '"/></g>';
    });
    return { glow: glow, dots: dots, halo: Math.max(6, Math.abs(z.cheekR.c.x - z.cheekL.c.x) * 0.09), core: Math.max(3, Math.abs(z.cheekR.c.x - z.cheekL.c.x) * 0.04) };
  }
  function paintFace(box, W, H, z, lit, idp, delayFn) {
    var mk = zoneMarkup(z, lit, W, idp, delayFn);
    var svgs = box.querySelectorAll('svg');
    svgs[0].querySelector('#' + idp + 'h feGaussianBlur').setAttribute('stdDeviation', mk.halo.toFixed(1));
    svgs[0].querySelector('#' + idp + 'c feGaussianBlur').setAttribute('stdDeviation', mk.core.toFixed(1));
    svgs[0].querySelector('.g-glow').innerHTML = mk.glow;
    svgs[1].querySelector('.g-dots').innerHTML = mk.dots;
  }

  // ---------- 1A · Scan Sweep (while the engine reads) ----------
  var busyTimer = null, busyStep = 0;
  function startBusy(b64) {
    var f = $('busy-face');
    f.innerHTML = '<img alt="Your scan photo" src="data:image/jpeg;base64,' + b64 + '">' + '<div class="veil"></div>' + faceLayers(1, 1, 'b') + '<div class="pts" id="busy-pts"></div>'
      + '<div class="sweep"><i></i><b></b></div><span class="live"><span class="dot"></span>Analyzing On Your Phone</span>';
    $('busy-chips').innerHTML = READ_ORDER.map(function (k) { return '<span class="rchip" data-k="' + k + '">' + CHIP[k] + '</span>'; }).join('');
    busyStep = 0; setBusy(0, 'Finding Your Face', 'Lining up 7 zones on your face.');
    show('s-busy');
    clearInterval(busyTimer);
    busyTimer = setInterval(function () {
      if (busyStep < READ_ORDER.length) { busyStep++; setBusy(busyStep, busyStep < READ_ORDER.length ? 'Reading Your ' + CHIP[READ_ORDER[busyStep]] : 'Building Your Skin Map', busyStep < READ_ORDER.length ? 'Mapping 7 zones and 8 measures. This takes a few seconds.' : 'Putting it all on your face.'); }
    }, 480);
  }
  function setBusy(n, title, msg) {
    $('busy-count').textContent = Math.min(n, 8) + '/8';
    $('busy-title').textContent = title; $('busy-msg').textContent = msg;
    var c = 2 * Math.PI * 36; $('busy-ring').setAttribute('stroke-dasharray', (c * Math.min(n, 8) / 8).toFixed(1) + ' ' + c.toFixed(1));
    document.querySelectorAll('#busy-chips .rchip').forEach(function (el, i) { el.className = 'rchip' + (i < n ? ' done' : i === n ? ' now' : ''); });
  }
  function busyZones(lm, W, H) {
    var f = $('busy-face'); if (!f || !lm || lm.length < 468 * 3) return;
    var svgs = f.querySelectorAll('svg'); svgs.forEach(function (s) { s.setAttribute('viewBox', '0 0 ' + W + ' ' + H); });
    var z = zonesFor(lm, W, H), all = Z_KEYS.map(function (k) { return { zone: k, opacity: 0.55, weight: 1 }; });
    paintFace(f, W, H, z, all, 'b', function (q) { return (2.6 * q.c.y / H - 0.2).toFixed(2) + 's'; });
    var fb = fitBox(f, W, H), pts = '';
    Z_KEYS.forEach(function (k) {
      var q = z[k];
      [[0, 0], [-0.55, -0.3], [0.55, 0.3], [-0.5, 0.35], [0.5, -0.35]].forEach(function (o, j) {
        var x = q.c.x + o[0] * q.rx * q.ax.x + o[1] * q.ry * q.ay.x, y = q.c.y + o[0] * q.rx * q.ax.y + o[1] * q.ry * q.ay.y;
        pts += '<span style="left:' + (fb.ox + x * fb.s).toFixed(0) + 'px;top:' + (fb.oy + y * fb.s).toFixed(0) + 'px;animation-delay:' + (((x * 3 + y * 7) % 13) / 5).toFixed(2) + 's"></span>';
      });
    });
    $('busy-pts').innerHTML = pts;
    f.classList.add('mapped');
  }
  function busyDone() {   // resolves once the reading animation has run through all 8 measures
    return new Promise(function (resolve) {
      (function wait() { if (busyStep >= READ_ORDER.length) { setTimeout(resolve, 350); } else setTimeout(wait, 120); })();
    });
  }
  function stopBusy() { clearInterval(busyTimer); busyTimer = null; }

  // ---------- 2B · Skin Map, concern by concern ----------
  var mapState = null;
  // Returns false (and the caller goes straight to the report) if there is nothing to map.
  function renderMap(a, r, b64, day) {
    var lm = r.landmarks;
    if (!lm || lm.length < 468 * 3 || !r.width || !r.height || !a.concerns || !a.concerns.length) { mapState = null; $('r-map').hidden = true; return false; }
    var measured = {};
    ((a.overlay_map && a.overlay_map.regions) || []).forEach(function (g) { if (g.zone && Z_ANCHORS[g.zone]) (measured[g.concern] = measured[g.concern] || {})[g.zone] = g.intensity; });
    var by = {}; a.concerns.forEach(function (c) { if (CHIP[c.concern]) by[c.concern] = c.score; });
    var list = Object.keys(by).sort(function (p, q) { return by[p] - by[q] || READ_ORDER.indexOf(p) - READ_ORDER.indexOf(q); });   // lowest first
    if (!list.length) { mapState = null; $('r-map').hidden = true; return false; }
    mapState = { W: r.width, H: r.height, zones: zonesFor(lm, r.width, r.height), photo: 'data:image/jpeg;base64,' + b64, by: by, list: list, measured: measured, i: 0 };
    $('r-map').hidden = false;
    $('map-day').textContent = 'Day ' + day + ' of ' + TEST_DAYS;
    $('map-face').innerHTML = '<img alt="Your scan photo" src="' + mapState.photo + '">' + faceLayers(r.width, r.height, 'm') + '<span class="tag" id="map-tag"></span>'
      + '<button class="arrow prev" id="map-prev" type="button" aria-label="Previous concern"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>'
      + '<button class="arrow next" id="map-nextc" type="button" aria-label="Next concern"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>'
      + '<div class="pager" id="map-dots" aria-hidden="true"></div>';
    $('map-cards').innerHTML = list.map(function (k, i) {
      var b = bandOf(by[k]);
      return '<button class="mcard" type="button" data-i="' + i + '" aria-label="' + CHIP[k] + ' ' + by[k] + '"><span class="mring">' + ringSvg(by[k], 54, 22, 4.5, b.col, 6) + '<b>' + by[k] + '</b></span><span class="mname">' + CHIP[k] + '</span></button>';
    }).join('');
    $('map-dots').innerHTML = list.map(function () { return '<i></i>'; }).join('');
    show('s-map');
    drawMap(true);
    return true;
  }
  function drawMap(reveal) {
    var m = mapState, W = m.W, H = m.H, z = m.zones, eye = z._eye;
    var concern = m.list[m.i], score = m.by[concern], lit = heatFor(concern, score, m.measured), b = bandOf(score);
    var f = $('map-face');
    f.classList.toggle('reveal', !!reveal);
    paintFace(f, W, H, z, lit, 'm', reveal ? function (q, i) { return (i * 160) + 'ms'; } : null);
    // Label pill beside the strongest zone (right of the T-zone, outer side of a cheek or under-eye); below the zone if it would run off the photo.
    var tag = $('map-tag'); tag.classList.remove('on');
    if (lit.length) {
      var t = z[lit[0].zone], fb = fitBox(f, W, H);
      tag.textContent = CHIP[concern] + ' · ' + score;
      var tw = tag.offsetWidth, faceMid = (z.cheekL.c.x + z.cheekR.c.x) / 2, k = fb.s;
      var left = t.key !== 'tzone' && t.key !== 'forehead' && t.key !== 'chin' && t.c.x < faceMid;
      var x = t.key === 'tzone' ? t.c.x + t.rx * 0.6 + eye * 0.06 : left ? t.c.x - t.rx - eye * 0.06 : t.c.x + t.rx + eye * 0.06;
      var px = fb.ox + x * k - (left ? tw : 0), py = fb.oy + t.c.y * k;
      var edge = 62;   // keep clear of the prev/next arrows on both sides of the photo
      if (px + tw > fb.bw - edge || px < edge) { px = fb.ox + t.c.x * k - tw / 2; py = fb.oy + (t.c.y + t.ry) * k + 20; }
      px = Math.max(edge, Math.min(fb.bw - tw - edge, px)); py = Math.max(20, Math.min(fb.bh - 50, py));
      tag.style.left = px.toFixed(0) + 'px'; tag.style.top = py.toFixed(0) + 'px';
      setTimeout(function () { tag.classList.add('on'); }, reveal ? 160 * lit.length + 450 : 0);
    }
    f.setAttribute('aria-label', CHIP[concern] + ' heat map on your scan photo. ' + heatSummary(concern, lit));
    document.querySelectorAll('#map-dots i').forEach(function (d, i) { d.className = i === m.i ? 'on' : ''; });
    $('map-ring').innerHTML = ringSvg(score, 76, 30, 5.5, b.col, 9) + '<b>' + score + '</b>';
    $('map-band').textContent = b.word + ' · ' + (m.i + 1) + ' of ' + m.list.length; $('map-band').style.color = b.col;
    $('map-name').textContent = CHIP[concern];
    $('map-line').textContent = heatSummary(concern, lit);
    $('map-learn').dataset.learn = concern;
    var strip = $('map-cards');
    strip.querySelectorAll('.mcard').forEach(function (c, i) { c.classList.toggle('on', i === m.i); c.setAttribute('aria-pressed', i === m.i); });
    var on = strip.querySelector('.mcard.on');
    if (on) strip.scrollTo({ left: Math.max(0, on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2), behavior: reveal ? 'smooth' : 'auto' });
  }
  function stepMap(d) { if (!mapState) return; mapState.i = (mapState.i + d + mapState.list.length) % mapState.list.length; drawMap(true); }
  $('s-map').addEventListener('click', function (e) {
    if (e.target.closest('#map-prev')) return stepMap(-1);
    if (e.target.closest('#map-nextc')) return stepMap(1);
    var c = e.target.closest('.mcard'); if (c && mapState && +c.dataset.i !== mapState.i) { mapState.i = +c.dataset.i; drawMap(true); }
  });
  (function swipe() {   // swipe the photo left/right to move between concerns
    var x0 = null, y0 = null, box = $('map-face');
    box.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    box.addEventListener('touchend', function (e) {
      if (x0 == null) return; var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) stepMap(dx < 0 ? 1 : -1);
    });
  })();
  $('map-next').addEventListener('click', function () { show('s-result'); });
  $('r-map').addEventListener('click', function () { if (mapState) { show('s-map'); drawMap(true); } });

  // ---------- learn more (4B pop-up sheet, approved Oct 30, 2026) ----------
  // Short, sourced explanations for each measure (Pulse Skin Research Library: definitions, how each measure presents by
  // depth, evidence-checked tips). "On Your Shade" speaks to the tester's own gemstone, never to skin-tone groups. The
  // sources describe differences by depth only, so the undertone shows on the chip but does not change the wording.
  // The shade comes from the tester's waitlist Find My Shade (state.tone, e.g. mst_6_warm); without one, the sheet asks
  // them to tap their gemstone once and remembers it on this phone.
  var EDU = {"gems": ["Pearl", "Selenite", "Moonstone", "Citrine", "Amber", "Tiger's Eye", "Bronzite", "Smoky Quartz", "Obsidian", "Onyx"], "group": {"Pearl": "A", "Selenite": "A", "Moonstone": "A", "Citrine": "B", "Amber": "B", "Tiger's Eye": "B", "Bronzite": "C", "Smoky Quartz": "C", "Obsidian": "C", "Onyx": "C"}, "swatch": {"Pearl": {"Cool": "#ffe8df", "Neutral": "#fbeae1", "Warm": "#ffe8d0"}, "Selenite": {"Cool": "#f1c4b5", "Neutral": "#e6c6ad", "Warm": "#e8c6a3"}, "Moonstone": {"Cool": "#e0a999", "Neutral": "#d4ab8f", "Warm": "#d6ab82", "Olive": "#c8af8f"}, "Citrine": {"Cool": "#c9907c", "Neutral": "#bc9373", "Warm": "#bd9364", "Olive": "#af9873"}, "Amber": {"Neutral": "#a97b5a", "Warm": "#aa7b4a", "Olive": "#9c805a"}, "Tiger's Eye": {"Cool": "#a56457", "Neutral": "#99684b", "Warm": "#9b683b", "Olive": "#8c6e49", "Red": "#a65d3f"}, "Bronzite": {"Neutral": "#83583d", "Warm": "#85582f", "Olive": "#785d3c", "Red": "#8e4e33"}, "Smoky Quartz": {"Neutral": "#73462f", "Warm": "#754620", "Red": "#7e3b26"}, "Obsidian": {"Cool": "#683431", "Warm": "#623519", "Olive": "#573b22", "Red": "#682c1e"}, "Onyx": {"Cool": "#341a18", "Neutral": "#2d1c14", "Warm": "#311a09", "Olive": "#2b1d10", "Red": "#33140b"}}, "base": {"Pearl": "#fceae0", "Selenite": "#e9c5aa", "Moonstone": "#d7aa8b", "Citrine": "#bf926e", "Amber": "#ac7a55", "Tiger's Eye": "#9c6746", "Bronzite": "#865739", "Smoky Quartz": "#76452b", "Obsidian": "#623522", "Onyx": "#2e1b13"}, "c": {"spots": {"what": "Flat patches that are darker than the skin around them, from extra melanin. Most are marks left after a breakout or irritation, sun spots, or melasma (patches linked to sun and hormones).", "how": "Pulse looks for areas darker than your own skin around them.", "shade": {"A": "On your {G} skin, spots usually look tan to light brown with fairly clear edges, often where your face sees the most sun.", "B": "On your {G} skin, spots usually look medium to dark brown, and marks from breakouts or picking can stay for months, so fading them takes patience.", "C": "On your {G} skin, marks from a breakout or irritation can come out darker and last longer than the breakout itself, from dark brown to gray. Calming irritation early helps most."}, "helps": "Daily SPF, ideally tinted with iron oxides, plus calming whatever is causing the marks. Azelaic acid or niacinamide help them fade over 8 to 12 weeks."}, "redness": {"what": "Color from extra blood flow just under the surface, usually from irritation, inflammation or flushing. It can come and go, or stick around.", "how": "Pulse looks at how much redder each zone is than the rest of your skin.", "shade": {"A": "On your {G} skin, redness shows up pink to bright red, so you'll usually spot it right away.", "B": "On your {G} skin, redness often looks muted, more red-brown or dusky than bright red, and it can leave a brown mark behind.", "C": "On your {G} skin, redness often looks purplish, dark brown or gray instead of red, so it's easy to miss. Warmth, stinging or bumps are better clues."}, "helps": "Fewer actives for two weeks, a fragrance-free cleanser, a barrier moisturizer and mineral SPF. Redness that burns, spreads or won't settle is worth a dermatologist visit."}, "oiliness": {"what": "The gloss of oil (sebum) on your skin's surface. Oil glands are densest on your forehead, nose and chin. A soft sheen is healthy, and a higher score means more balanced oil.", "how": "Pulse looks for bright, glossy highlights across your face.", "shade": {"A": "On your {G} skin, shine shows as a soft gloss, mostly across your T-zone.", "B": "On your {G} skin, shine catches the light as brighter highlights on your T-zone, so a little oil can look like more in a photo.", "C": "On your {G} skin, highlights stand out more, so the same oil can look shinier in a photo than it does in person."}, "helps": "Keep moisturizing (oily skin still needs it), wash with a gel cleanser, and try niacinamide in the morning."}, "texture": {"what": "How smooth your skin's surface is: fine roughness, small bumps, or dips like old breakout scars. A flat dark mark is a color change, not texture.", "how": "Pulse reads fine unevenness across the surface of your skin.", "shade": {"A": "On your {G} skin, texture mostly shows as shadow: small dips, bumps or roughness, sometimes with pink marks around them.", "B": "On your {G} skin, old breakout scars often carry a brown tint, so one spot can read as both texture and a dark mark.", "C": "On your {G} skin, small bumps can look brown or dark rather than red, and harsh scrubs can leave marks behind. Gentle wins."}, "helps": "A gentle exfoliant like lactic or mandelic acid once or twice a week, and moisturizer every night. Never exfoliate and use retinol on the same night."}, "pores": {"what": "The openings where oil reaches your skin's surface. They look bigger when they're clogged, stretched or catching shadow, mostly on your nose, forehead and inner cheeks.", "how": "Pulse reads the fine detail on your nose and cheeks, where pores show most.", "shade": {"A": "On your {G} skin, pores show as small round openings and look bigger when there's shadow.", "B": "On your {G} skin, pores can look a little darker than the skin around them, especially on your nose and cheeks.", "C": "On your {G} skin, pores show more through shadow and shine than as dark dots, so even, front-facing light gives the truest read."}, "helps": "Salicylic acid a few nights a week keeps pores clear, and niacinamide helps over about 8 weeks. Clear pores look smaller."}, "acne": {"what": "Acne starts when oil and dead skin plug a pore. It can stay a blackhead or whitehead, or turn into an inflamed bump.", "how": "Pulse looks for small spots that stand out from the skin around them.", "shade": {"A": "On your {G} skin, breakouts usually look red and often leave pink marks that fade with time.", "B": "On your {G} skin, breakouts can look pink to brown, and the brown mark they leave can outlast the breakout itself.", "C": "On your {G} skin, breakouts can look dark or skin-toned rather than red, and the mark they leave is often the bigger issue. Hands off."}, "helps": "Wash gently with your fingertips twice a day. Benzoyl peroxide or salicylic acid, and adapalene a few nights a week. Painful or scarring breakouts belong with a dermatologist."}, "dark_circles": {"what": "Darker skin under your eyes from some mix of extra pigment, blood vessels showing through thin skin, and shadow from the shape of the area.", "how": "Pulse compares your under-eyes to your cheeks.", "shade": {"A": "On your {G} skin, circles often look blue, violet or pinkish, from blood vessels showing through thin under-eye skin.", "B": "On your {G} skin, circles usually mix brown pigment with a little shadow, and can reach your upper lids too.", "C": "On your {G} skin, circles are mostly pigment, brown to near-black, sometimes on your upper lids too. For a lot of people that's simply their natural coloring."}, "helps": "SPF around your eyes, a caffeine eye gel in the morning, and a vitamin C or niacinamide eye cream. Face the light when you scan, since overhead light deepens shadows."}, "radiance": {"what": "Your glow: how even, smooth and softly luminous your skin looks. It comes from even tone, smooth texture, hydration and a soft, not greasy, sheen. It's never about being lighter.", "how": "Pulse reads how even your tone and surface are across your face.", "shade": {"A": "On your {G} skin, dullness tends to look sallow or grayish, often with blotchy redness.", "B": "On your {G} skin, radiance dips mostly when tone gets uneven from patches or marks, or when skin loses its natural shine.", "C": "On your {G} skin, dullness often shows as ashiness, a gray, dry cast. Hydration is what brings your glow back."}, "helps": "Moisturize morning and night, vitamin C in the morning to even your tone, and a gentle exfoliant once a week."}}, "band": {"Doing Well": "This is a strength right now. Keep doing what you're doing.", "Watch": "Not a problem, just worth a little attention in your routine.", "Needs Focus": "This is where your routine can make the biggest difference."}};
  var lastRead = null;   // { by, nm, where } from the latest scan
  function myShade() {
    var m = /^mst_(\d+)(?:_([a-z]+))?$/.exec((state && state.tone) || ''), gem = null, und = null;
    if (m && +m[1] >= 1 && +m[1] <= 10) { gem = EDU.gems[+m[1] - 1]; und = m[2] && m[2] !== 'unsure' ? m[2][0].toUpperCase() + m[2].slice(1) : null; }
    if (!gem) { try { gem = localStorage.getItem('pulse_webtest_gem'); } catch (e) {} if (EDU.gems.indexOf(gem) < 0) gem = null; }
    if (und && !(EDU.swatch[gem] || {})[und]) und = null;
    return gem ? { gem: gem, und: und, sw: und ? EDU.swatch[gem][und] : EDU.base[gem] } : null;
  }
  function openLearn(k) {
    var c = EDU.c[k]; if (!c || !lastRead) return;
    var v = lastRead.by[k] ? lastRead.by[k].score : null, b = v == null ? null : bandOf(v), sh = myShade();
    var shadeBox = sh
      ? '<div class="lshade"><span class="lk">On Your Shade</span><p>' + esc(c.shade[EDU.group[sh.gem]].replace('{G}', sh.gem)) + '</p></div>'
      : '<div class="lshade"><span class="lk">On Your Shade</span><p>Tap your shade to see how this shows on your skin.</p><div class="gems">'
        + EDU.gems.map(function (g) { return '<button type="button" class="gem" data-gem="' + esc(g) + '" aria-label="' + esc(g) + '" title="' + esc(g) + '" style="background:' + EDU.base[g] + '"></button>'; }).join('') + '</div></div>';
    var why = v == null
      ? (lastRead.nm.indexOf(k) >= 0 ? 'Not measured on this scan: ' + NM_WHY[k] + '.' : 'Not measured on this scan.') + ' ' + c.how
      : (lastRead.where[k] ? lastRead.where[k] + ' ' : '') + EDU.band[b.word] + ' ' + c.how;
    $('learn-body').innerHTML =
      '<div class="lhead"><div class="lring">' + (v == null ? ringSvg(0, 72, 30, 6, 'rgba(255,246,234,.3)', 0) + '<b>–</b>' : ringSvg(v, 72, 30, 6, b.col, 6 + Math.floor(v / 10)) + '<b>' + v + '</b>') + '</div>'
      + '<div class="lt"><h2 id="learn-title">' + CHIP[k] + '</h2><span class="lband" style="color:' + (b ? b.col : '#C4AD9F') + '">' + (b ? b.word : 'Not Measured') + '</span></div>'
      + '<button type="button" class="lclose" id="learn-close" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F8EDE4" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>'
      + '<div class="lscroll">' + (sh ? '<span class="lchip"><i style="background:' + sh.sw + '"></i>Your Shade · ' + esc(sh.gem) + (sh.und ? ' · ' + sh.und : '') + '</span>' : '')
      + '<div class="lsec"><span class="lk">What It Is</span><p>' + esc(c.what) + '</p></div>' + shadeBox
      + '<div class="lsec"><span class="lk">' + (v == null ? 'Why No Score' : 'Why You Scored ' + v) + '</span><p>' + esc(why) + '</p></div>'
      + '<div class="lsec"><span class="lk">What Helps</span><p>' + esc(c.helps) + '</p></div>'
      + '<p class="lnote">Pulse describes how your skin looks. It doesn&#39;t diagnose.</p>'
      + (mapState && mapState.list.indexOf(k) >= 0 ? '<button class="btn" type="button" id="learn-map" data-k="' + k + '">See It On My Skin Map</button>' : '') + '</div>';
    var l = $('learn'); l.dataset.k = k;
    if (l.hidden) { l.hidden = false; document.body.classList.add('locked'); requestAnimationFrame(function () { l.classList.add('on'); $('learn-close').focus(); }); }
  }
  function closeLearn() {
    var l = $('learn'); l.classList.remove('on'); document.body.classList.remove('locked');
    setTimeout(function () { if (!l.classList.contains('on')) l.hidden = true; }, 280);
  }
  $('learn').addEventListener('click', function (e) {
    if (e.target === $('learn') || e.target.closest('#learn-close')) return closeLearn();
    var g = e.target.closest('.gem');
    if (g) { try { localStorage.setItem('pulse_webtest_gem', g.dataset.gem); } catch (err) {} openLearn($('learn').dataset.k); return; }
    var mb = e.target.closest('#learn-map');
    if (mb && mapState) { closeLearn(); mapState.i = mapState.list.indexOf(mb.dataset.k); show('s-map'); drawMap(true); }
  });
  $('learn').addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLearn(); });
  document.addEventListener('click', function (e) { var t = e.target.closest('[data-learn]'); if (t) openLearn(t.dataset.learn); });

  // ---------- routine plan: a port of public.routine_plan (migration 17) for the 8 measured concerns ----------
  // No skin profile in the test (adults only, no pregnancy or sensitivity answers), so those branches are off;
  // "deeper skin tone" comes from the engine's measured skin lightness (L* below 46).
  var RULES = [
    ['acne', 'both', 'cleanser', 'Wash with a gentle salicylic acid cleanser', ['salicylic acid'], 14, null, 'gentle', 'Keeps pores clear without stripping, which is what triggers more oil and more breakouts.', 1, false],
    ['acne', 'pm', 'treatment', 'Spot-treat or thin-layer a breakout treatment', ['benzoyl peroxide 2.5%', 'adapalene 0.1%'], 7, 3, 'moderate', 'Benzoyl peroxide or adapalene are the two best-studied over-the-counter breakout actives; start three nights a week to avoid irritation.', 1, true],
    ['acne', 'am', 'spf', 'Finish with SPF 30 or higher', ['zinc oxide'], 7, null, 'gentle', 'Breakout marks darken in sunlight, especially on deeper skin tones.', 2, false],
    ['oiliness', 'both', 'cleanser', 'Wash with a gel cleanser', [], 14, null, 'gentle', 'A gel formula removes excess oil; a foaming one often over-strips and makes oil worse.', 2, false],
    ['oiliness', 'am', 'serum', 'Niacinamide serum before moisturizer', ['niacinamide 5%'], 7, null, 'gentle', 'Niacinamide steadies oil production over 4 to 8 weeks.', 2, false],
    ['oiliness', 'pm', 'exfoliant', 'Exfoliate with a BHA', ['salicylic acid 2%'], 2, 1, 'moderate', 'Salicylic acid dissolves oil inside the pore. Twice a week is plenty; more causes rebound oil.', 3, false],
    ['oiliness', 'both', 'moisturizer', 'A light, oil-free moisturizer', [], 14, null, 'gentle', 'Skipping moisturizer tells skin to make more oil.', 3, false],
    ['pores', 'pm', 'exfoliant', 'Exfoliate with a BHA', ['salicylic acid 2%'], 2, 1, 'moderate', 'Pores look larger when they are full; BHA clears them. Once a week to start.', 3, false],
    ['pores', 'am', 'serum', 'Niacinamide serum', ['niacinamide 5%'], 7, null, 'gentle', 'Reduces the look of pores over about 8 weeks.', 3, false],
    ['spots', 'am', 'serum', 'Vitamin C serum in the morning', ['vitamin C 10-15%'], 7, null, 'moderate', 'Brightens existing marks and helps SPF prevent new ones.', 1, false],
    ['spots', 'am', 'spf', 'SPF 30 or higher, reapplied if outside', ['zinc oxide', 'iron oxides'], 7, null, 'gentle', 'The single biggest factor in dark spots fading or staying; tinted mineral SPF with iron oxides also blocks visible light.', 1, false],
    ['spots', 'pm', 'treatment', 'Pigment treatment at night', ['azelaic acid 10%', 'tranexamic acid'], 7, null, 'moderate', 'Azelaic and tranexamic acid fade marks and are safe on deeper skin tones, where hydroquinone can rebound.', 2, false],
    ['spots', 'pm', 'exfoliant', 'A gentle exfoliant once a week', ['lactic acid', 'mandelic acid'], 1, 1, 'gentle', 'Lifts dull, pigmented surface cells; once a week is enough and avoids the irritation that darkens spots.', 4, false],
    ['texture', 'pm', 'exfoliant', 'Exfoliate with a gentle AHA', ['lactic acid', 'mandelic acid'], 2, 1, 'gentle', 'Lactic and mandelic acids smooth texture with the least irritation on deeper skin tones. Once a week for two weeks, then twice.', 2, false],
    ['texture', 'both', 'moisturizer', 'Moisturize morning and night', ['glycerin', 'ceramides'], 14, null, 'gentle', 'Smooth skin starts with hydrated skin; exfoliating without it roughens texture.', 3, false],
    ['redness', 'both', 'cleanser', 'A fragrance-free cream cleanser', [], 14, null, 'gentle', 'Fragrance and foaming agents are the most common triggers for redness.', 1, false],
    ['redness', 'pm', 'serum', 'A calming serum at night', ['azelaic acid 10%', 'centella asiatica', 'niacinamide'], 7, null, 'gentle', 'Azelaic acid and centella calm redness; both are gentle enough for nightly use.', 2, false],
    ['redness', 'am', 'spf', 'Mineral SPF every morning', ['zinc oxide'], 7, null, 'gentle', 'Heat and UV flare redness; mineral filters irritate less than chemical ones.', 1, false],
    ['redness', 'pm', 'exfoliant', 'Pause exfoliating for two weeks', [], 0, 0, 'gentle', 'Red skin is usually irritated skin. Let the barrier recover before any acids.', 1, false],
    ['radiance', 'am', 'serum', 'Vitamin C serum in the morning', ['vitamin C 10-15%'], 7, null, 'moderate', 'Brightens tone and evens out dullness over 4 to 8 weeks.', 2, false],
    ['radiance', 'pm', 'exfoliant', 'A gentle exfoliant once a week', ['lactic acid', 'mandelic acid'], 1, 1, 'gentle', 'Dull skin is often a layer of dead cells; once a week is enough to clear it.', 3, false],
    ['radiance', 'both', 'moisturizer', 'Moisturize morning and night', ['glycerin', 'hyaluronic acid'], 14, null, 'gentle', 'Hydrated skin reflects light; dehydrated skin reads as dull.', 3, false],
    ['dark_circles', 'am', 'eye_cream', 'Caffeine eye cream in the morning', ['caffeine', 'vitamin C'], 7, null, 'gentle', 'Caffeine constricts the vessels that show through thin under-eye skin.', 2, false],
    ['dark_circles', 'pm', 'eye_cream', 'Retinol eye cream, three nights a week', ['retinol 0.1%'], 3, 2, 'gentle', 'Thickens under-eye skin over months so vessels and pigment show less. Pigment-type circles also need SPF.', 3, true],
    ['dark_circles', 'am', 'spf', 'SPF to the eye area too', ['zinc oxide'], 7, null, 'gentle', 'Under-eye pigment darkens with sun, especially on deeper tones.', 3, false],
  ].map(function (r) { return { concern: r[0], period: r[1], step_type: r[2], label: r[3], ingredients: r[4], per_week: r[5], start_per_week: r[6] == null ? r[5] : r[6], intensity: r[7], why: r[8], priority: r[9], retinoid: r[10] }; });
  var POS = { cleanser: 1, toner: 2, exfoliant: 3, serum: 4, treatment: 5, eye_cream: 6, moisturizer: 7, oil: 8, spf: 9 };
  var INT = { gentle: 0, moderate: 1, strong: 2 };
  function routinePlan(a) {
    var focus = a.concerns.slice().sort(function (p, q) { return p.score - q.score; }).slice(0, 3);
    var hasRedness = focus.some(function (f) { return f.concern === 'redness'; });
    var deep = a.quality && a.quality.skin_l != null && a.quality.skin_l < 46;
    var ord = {}; focus.forEach(function (f, i) { ord[f.concern] = i; });
    var matched = RULES.filter(function (r) { return ord.hasOwnProperty(r.concern) && !(r.step_type === 'exfoliant' && hasRedness && r.concern !== 'redness'); });
    var groups = {};
    matched.forEach(function (r) { var k = r.period + '|' + r.step_type; (groups[k] = groups[k] || []).push(r); });
    var merged = Object.keys(groups).map(function (k) {
      var g = groups[k].slice().sort(function (p, q) { return p.priority - q.priority || ord[p.concern] - ord[q.concern]; });
      var strict = g[0].step_type === 'exfoliant' || g[0].step_type === 'treatment';
      var ing = []; g.forEach(function (r) { r.ingredients.forEach(function (x) { if (ing.indexOf(x) < 0) ing.push(x); }); });
      return { period: g[0].period, step_type: g[0].step_type, label: g[0].label, why: g[0].why, ingredients: ing,
        per_week: strict ? Math.min.apply(null, g.map(function (r) { return r.per_week; })) : g[0].per_week,
        start_per_week: strict ? Math.min.apply(null, g.map(function (r) { return r.start_per_week; })) : g[0].start_per_week,
        intensity: g.slice().sort(function (p, q) { return INT[p.intensity] - INT[q.intensity]; })[0].intensity,
        concerns: g.map(function (r) { return r.concern; }).filter(function (c, i, arr) { return arr.indexOf(c) === i; }),
        retinoid: g.some(function (r) { return r.retinoid; }) };
    });
    var steps = [];
    merged.forEach(function (m) {
      if (m.period === 'both') ['am', 'pm'].forEach(function (p) { steps.push(Object.assign({}, m, { period: p, per_week: Math.min(7, Math.floor(m.per_week / 2)), start_per_week: Math.min(7, Math.floor(m.start_per_week / 2)) })); });
      else steps.push(m);
    });
    var has = function (p, t) { return steps.some(function (s) { return s.period === p && s.step_type === t; }); };
    if (!has('am', 'cleanser')) steps.push({ period: 'am', step_type: 'cleanser', label: 'Wash with a gentle cleanser', ingredients: [], per_week: 7, start_per_week: 7, intensity: 'gentle', why: 'Clean skin lets everything after it work.', concerns: [], retinoid: false });
    if (!has('pm', 'cleanser')) steps.push({ period: 'pm', step_type: 'cleanser', label: 'Wash with a gentle cleanser', ingredients: [], per_week: 7, start_per_week: 7, intensity: 'gentle', why: 'Takes off SPF, oil and the day.', concerns: [], retinoid: false });
    if (!has('am', 'moisturizer')) steps.push({ period: 'am', step_type: 'moisturizer', label: 'Moisturize', ingredients: [], per_week: 7, start_per_week: 7, intensity: 'gentle', why: 'Keeps the barrier calm so actives are tolerated.', concerns: [], retinoid: false });
    if (!has('pm', 'moisturizer')) steps.push({ period: 'pm', step_type: 'moisturizer', label: 'Moisturize', ingredients: [], per_week: 7, start_per_week: 7, intensity: 'gentle', why: 'Overnight is when skin repairs.', concerns: [], retinoid: false });
    if (!has('am', 'spf')) steps.push({ period: 'am', step_type: 'spf', label: 'SPF 30 or higher, every morning', ingredients: [], per_week: 7, start_per_week: 7, intensity: 'gentle', why: 'Non-negotiable for every concern on every skin tone.', concerns: [], retinoid: false });
    steps.forEach(function (s) {
      s.caution = s.retinoid ? 'Not with the exfoliant on the same night. Expect mild dryness the first two weeks.' : (s.step_type === 'exfoliant' && s.per_week > 0 ? 'Skip it any night your skin feels tight or stings.' : null);
    });
    steps.sort(function (p, q) { return (p.period === 'am' ? 0 : 1) - (q.period === 'am' ? 0 : 1) || (POS[p.step_type] || 10) - (POS[q.step_type] || 10); });
    var cautions = [];
    if (hasRedness) cautions.push('Your redness score is low, so acids and scrubs are paused for two weeks. Add them back one at a time.');
    if (deep) cautions.push('On deeper skin tones irritation turns into dark marks, so the plan favors gentle acids (lactic, mandelic, azelaic) over strong ones.');
    cautions.push('Introduce one new product at a time, three to four days apart, so a reaction has an obvious cause.');
    cautions.push('If you are pregnant, nursing, or have sensitive skin, skip the retinoid steps and start every active at once a week.');
    return { focus: focus, steps: steps, cautions: cautions };
  }

  // ---------- withdraw + relink ----------
  $('withdraw').addEventListener('click', function () {
    if (!confirm('Withdraw from the test? Your scores and any photos will be destroyed and this link will stop working.')) return;
    api('withdraw').then(function (r) {
      if (!r.ok) { alert('Could not withdraw right now (' + (r.error || 'network') + '). Email hello@pulsecosmeticsolutions.com and it will be done by hand.'); return; }
      try { localStorage.removeItem('pulse_webtest_t'); } catch (e) {}
      token = null; stopCamera(); $('withdraw-row').hidden = true; show('s-withdrawn');
    });
  });
  $('relink').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('relink').email.value.trim(); if (!email) return;
    api('request_link', { email: email }).then(function () { $('relink').hidden = true; $('relink-done').hidden = false; });
  });

  // ---------- boot ----------
  function boot() {
    // The engine iframe is created here, after the message listener above exists, so its 'ready' is never missed.
    var fr = document.createElement('iframe'); fr.id = 'engine'; fr.src = 'engine.html'; fr.title = 'Pulse analysis engine'; fr.setAttribute('aria-hidden', 'true');
    document.body.appendChild(fr);
    var q = new URLSearchParams(location.search).get('t');
    if (q) { token = q; try { localStorage.setItem('pulse_webtest_t', q); } catch (e) {} window.history.replaceState(null, '', location.pathname); }
    else { try { token = localStorage.getItem('pulse_webtest_t'); } catch (e) {} }
    if (!token) { show('s-gate'); return; }
    api('history').then(function (r) {
      if (!r.ok) { token = null; try { localStorage.removeItem('pulse_webtest_t'); } catch (e) {} show('s-gate'); return; }
      state = r.state; history = r.scans || [];
      if (state.withdrawn) { show('s-withdrawn'); return; }
      if (!state.consented) { show('s-consent'); return; }
      renderHome();
    });
  }
  boot();
})();
