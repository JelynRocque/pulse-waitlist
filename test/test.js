/* Pulse friends-and-family web test. See index.html for what this is.
   Flow: link token → consent → (engine ready) → camera with live checks → analyze in the browser → send scores → results + routine → history.
   Only `analysis` (scores, confidence, quality) ever leaves the phone. Landmarks are never requested. */
(function () {
  'use strict';
  var API = window.PULSE_TEST_API || 'https://bgagcxdsqnasgegazusf.supabase.co/functions/v1/webtest';   // Pulse dev project; switch to staging before the first real tester. PULSE_TEST_API: local end-to-end test only
  var CONSENT_VERSION = 'webtest-v1-2026-10-28';
  var TEST_DAYS = 14;
  var $ = function (id) { return document.getElementById(id); };
  var token = null, state = null, history = [], engineReady = false, engineFailed = false;

  // ---------- helpers ----------
  function show(id) { document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('on'); }); $(id).classList.add('on'); window.scrollTo(0, 0); }
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
  function engineRun(b64, mode) {
    return new Promise(function (resolve) {
      if (!engineReady) return resolve({ ok: false, error: engineFailed ? 'engine_unavailable' : 'engine_loading' });
      var id = 'j' + (++seq); pending[id] = resolve;
      var t = setTimeout(function () { if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'timeout' }); } }, 30000);
      pending[id] = function (r) { clearTimeout(t); resolve(r); };
      try { $('engine').contentWindow.__pulse({ id: id, b64: b64, mode: mode, wantLandmarks: false }); }
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
    show('s-busy'); $('busy-msg').textContent = 'Reading 8 measures on your phone…';
    engineRun(b64, 'analyze').then(function (r) {
      if (!r.ok || !r.face || !r.analysis) { alert(!r.ok ? 'The engine could not read that photo. Try again in better light.' : 'No face found. Try again, closer to the camera.'); renderHome(); return; }
      var a = r.analysis;
      $('busy-msg').textContent = 'Saving your scores…';
      var body = { local_date: localDate(), result: { model_version: a.model_version, skin_score: a.skin_score, skin_type: a.skin_type, confidence: a.confidence, concerns: a.concerns, quality: a.quality, lighting_signature: a.lighting_signature } };
      if (state && state.keep_photos) body.photo_b64 = b64;
      api('scan', body).then(function (res) {
        if (!res.ok) { alert('Your reading could not be saved (' + (res.error || 'network') + '). It is shown below but will not count.'); }
        else history.push({ id: res.scan_id, date: localDate(), day: res.day_index, skin_score: a.skin_score, concerns: a.concerns, not_measured: a.quality.not_measured || [], issues: a.quality.issues || [] });
        renderResult(a, res.ok ? res.day_index : dayIndex());
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
    $('r-score').textContent = a.skin_score;
    var nm = a.quality.not_measured || [];
    $('r-note').textContent = (a.status === 'low_confidence' ? 'Low-confidence reading (' + (TIP[a.reason] ? TIP[a.reason].replace(/\.$/, '').toLowerCase() : a.reason) + '). Scores still count, but a rescan in better light is worth it. ' : '')
      + (a.skin_type ? 'Skin reads as ' + a.skin_type + ' today.' : '');
    var by = {}; a.concerns.forEach(function (c) { by[c.concern] = c; });
    $('r-measures').innerHTML = ORDER.map(function (k) {
      var c = by[k];
      if (!c) return '<div class="m nm"><span class="name">' + NAME[k] + '</span><span class="val">Not measured</span><span class="muted" style="grid-column:1/-1;font-size:13px">' + (nm.indexOf(k) >= 0 ? 'Skipped: ' + NM_WHY[k] + '.' : 'Skipped in this photo.') + '</span></div>';
      var b = band(c.score);
      return '<div class="m"><span class="name">' + NAME[k] + '</span><span class="val">' + c.score + '</span><span class="bar"><i style="width:' + c.score + '%"></i></span><span class="band ' + b[0] + '">' + b[1] + '</span></div>';
    }).join('');
    var plan = routinePlan(a);
    $('r-am').innerHTML = plan.steps.filter(function (s) { return s.period === 'am'; }).map(stepHtml).join('');
    $('r-pm').innerHTML = plan.steps.filter(function (s) { return s.period === 'pm'; }).map(stepHtml).join('');
    $('r-cautions').innerHTML = plan.cautions.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
    var firstDayScans = history.filter(function (s) { return s.day === 1; }).length;
    $('r-again').hidden = !(day === 1 && firstDayScans === 1);
    show('s-result');
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
