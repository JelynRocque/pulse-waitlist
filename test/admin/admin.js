/* Founder page for the friends-and-family test. All calls go to the webtest Edge Function with the founder key. */
(function () {
  'use strict';
  var API = window.PULSE_TEST_API || 'https://bgagcxdsqnasgegazusf.supabase.co/functions/v1/webtest';   // keep in step with ../test.js
  var $ = function (id) { return document.getElementById(id); };
  var key = null, testers = [], emailConfigured = false, links = {};   // links: email → link issued in this session (shown once)

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(action, body) {
    body = body || {}; body.action = action;
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify(body) })
      .then(function (r) { return r.status === 401 ? { error: 'unauthorized' } : r.json(); }).catch(function () { return { error: 'network' }; });
  }
  function when(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

  // ---------- login ----------
  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault(); key = $('key').value.trim(); if (!key) return;
    api('admin.check').then(function (r) {
      if (!r.ok) { $('login-err').textContent = r.error === 'unauthorized' ? 'That key is not right.' : 'Could not reach the server.'; $('login-err').hidden = false; return; }
      try { sessionStorage.setItem('pulse_webtest_admin', key); } catch (err) {}
      emailConfigured = r.email_configured; open();
    });
  });
  function open() {
    $('login').hidden = true; $('app').hidden = false;
    $('email-note').textContent = emailConfigured ? 'Invitation emails are on: switching someone to Active emails their link from hello@pulseskin.co.' : 'Email is not configured on this project yet (RESEND_API_KEY). Switching someone to Active still creates their link; copy it from the table and send it yourself.';
    load();
  }

  // ---------- list ----------
  function load() {
    api('admin.progress').then(function (r) {
      if (!r.ok) { $('rows').innerHTML = '<tr><td colspan="7">Could not load (' + esc(r.error) + ').</td></tr>'; return; }
      testers = r.testers || []; render();
    });
  }
  function render() {
    var active = testers.filter(function (t) { return t.active && !t.withdrawn_at; }).length;
    var consented = testers.filter(function (t) { return t.consented_at && !t.withdrawn_at; }).length;
    var scans = testers.reduce(function (n, t) { return n + (+t.scans || 0); }, 0);
    var photos = testers.reduce(function (n, t) { return n + (+t.photos || 0); }, 0);
    var withdrawn = testers.filter(function (t) { return t.withdrawn_at; }).length;
    $('cards').innerHTML = [[testers.length - withdrawn, 'on the list'], [active, 'active'], [consented, 'consented'], [scans, 'scans'], [photos, 'photos kept'], [withdrawn, 'withdrawn']]
      .map(function (c) { return '<div class="card"><b>' + c[0] + '</b><span>' + c[1] + '</span></div>'; }).join('');
    $('count').textContent = testers.length + ' people';
    $('rows').innerHTML = testers.map(function (t) {
      var wd = !!t.withdrawn_at;
      var status = wd ? '<span class="tag wd">Withdrawn</span>' : t.active ? '<span class="tag on">Active</span>' : '<span class="tag off">Inactive</span>';
      var invite = wd ? '' : t.active ? (t.invite_sent_at ? '<div class="muted">Invite emailed ' + when(t.invite_sent_at) + '</div>' : t.invite_error ? '<div class="muted" style="color:var(--warn)">Email not sent (' + esc(t.invite_error) + '); send the link yourself</div>' : '') : '';
      var link = links[t.email] ? '<div class="link-box">' + esc(links[t.email]) + '</div><button class="btn ghost tiny" data-copy="' + esc(links[t.email]) + '" type="button">Copy link</button>' : '';
      var consent = wd ? '—' : t.consented_at ? when(t.consented_at) + (t.keep_photos ? ' <span class="tag warn">photos</span>' : '') : '<span class="muted">not yet</span>';
      var sc = wd ? '—' : (t.days_scanned || 0) + ' day' + (t.days_scanned === 1 ? '' : 's') + ' · ' + (t.scans || 0) + ' scan' + (t.scans === 1 ? '' : 's') + (t.last_scan ? '<div class="muted">last ' + when(t.last_scan) + '</div>' : '');
      var cons = wd || !t.scans ? '—' : 'mean ' + (t.mean_score == null ? '—' : t.mean_score) + ' · ±' + t.score_spread + (t.skin_l != null ? '<div class="muted">skin L* ' + t.skin_l + '</div>' : '');
      var flags = wd || !t.scans ? '—' : (t.issue_scans || 0) + ' lighting · ' + (t.not_measured_scans || 0) + ' skipped';
      var sw = wd ? '' : t.active
        ? '<button class="btn ghost tiny" data-switch="off" data-email="' + esc(t.email) + '" type="button">Set inactive</button>'
        : '<button class="btn tiny" data-switch="on" data-email="' + esc(t.email) + '" type="button">' + (t.invite_sent_at ? 'Reactivate + email' : 'Activate + email invite') + '</button>';
      var ph = t.photos ? ' <button class="btn ghost tiny" data-photos="' + esc(t.email) + '" type="button">Photos (' + t.photos + ')</button>' : '';
      return '<tr><td><strong>' + esc(t.name || '') + '</strong><div class="muted">' + esc(t.email) + '</div>' + invite + link + '<div class="photos" id="ph-' + esc(t.id) + '"></div></td><td>' + status + '</td><td class="hide-sm">' + consent + '</td><td>' + sc + '</td><td class="hide-sm">' + cons + '</td><td class="hide-sm">' + flags + '</td><td>' + sw + ph + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted">Nobody yet. Add a tester above.</td></tr>';
  }
  $('rows').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.copy) { navigator.clipboard.writeText(b.dataset.copy).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy link'; }, 1500); }); return; }
    if (b.dataset.switch) {
      var on = b.dataset.switch === 'on', email = b.dataset.email;
      if (on && !confirm('Activate ' + email + '?\n\nThis creates their private link' + (emailConfigured ? ' and emails the invitation now.' : '. Email is not configured, so you will need to send the link yourself.'))) return;
      if (!on && !confirm('Set ' + email + ' inactive? Their link stops working. Their data stays.')) return;
      b.disabled = true;
      api('admin.set_active', { email: email, active: on }).then(function (r) {
        if (!r.ok) { alert('Could not switch (' + (r.error || 'unknown') + ').'); b.disabled = false; return; }
        if (on) { links[email] = r.link; if (!r.email_sent) alert('Link created, but the email was not sent (' + (r.email_error || 'not configured') + '). Copy the link from the table and send it yourself.'); }
        else delete links[email];
        load();
      });
      return;
    }
    if (b.dataset.photos) {
      var t = testers.filter(function (x) { return x.email === b.dataset.photos; })[0]; if (!t) return;
      b.disabled = true;
      api('admin.photos', { email: t.email }).then(function (r) {
        b.disabled = false; if (!r.ok) { alert('Could not load photos.'); return; }
        $('ph-' + t.id).innerHTML = (r.photos || []).map(function (p) { return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" alt="scan ' + esc(when(p.at)) + '"></a>'; }).join('') || '<span class="muted">No photos stored.</span>';
      });
    }
  });

  // ---------- add ----------
  function addOne(name, email) { return api('admin.add', { name: name, email: email }); }
  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('add-email').value.trim().toLowerCase(), name = $('add-name').value.trim();
    addOne(name, email).then(function (r) {
      $('add-msg').className = 'msg ' + (r.ok ? 'ok' : 'bad');
      $('add-msg').textContent = !r.ok ? (r.error === 'bad_email' ? 'That email does not look right.' : 'Could not add (' + r.error + ').') : r.existing ? (r.withdrawn ? email + ' withdrew earlier; they cannot be re-added.' : email + ' is already on the list.') : 'Added ' + email + ' (inactive). Switch them to Active when you are ready.';
      if (r.ok) { $('add-email').value = ''; $('add-name').value = ''; load(); }
    });
  });
  $('add-bulk-toggle').addEventListener('click', function () { $('bulk').hidden = !$('bulk').hidden; });
  $('bulk-add').addEventListener('click', function () {
    var lines = $('bulk-text').value.split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var done = 0, bad = 0;
    (function next() {
      if (!lines.length) { $('add-msg').className = 'msg ok'; $('add-msg').textContent = 'Added ' + done + (bad ? ', skipped ' + bad : '') + '. All inactive until you switch them on.'; $('bulk-text').value = ''; load(); return; }
      var l = lines.shift(), m = /([^\s,;<>]+@[^\s,;<>]+)/.exec(l);
      if (!m) { bad++; return next(); }
      var name = l.replace(m[1], '').replace(/[<>,;]/g, ' ').trim();
      addOne(name, m[1].toLowerCase()).then(function (r) { if (r.ok && !r.existing) done++; else bad++; next(); });
    })();
  });

  // ---------- export ----------
  $('refresh').addEventListener('click', load);
  $('export').addEventListener('click', function () {
    api('admin.export').then(function (r) {
      if (!r.ok) { alert('Could not export.'); return; }
      var M = ['spots', 'redness', 'oiliness', 'texture', 'pores', 'acne', 'dark_circles', 'radiance'];
      var head = ['tester', 'scan_id', 'at', 'date', 'day', 'engine', 'skin_score', 'skin_type', 'confidence'].concat(M).concat(['not_measured', 'issues', 'sharpness', 'noise', 'skin_l', 'mean_luma', 'color_temp', 'photo']);
      var rows = r.rows.map(function (s) {
        var by = {}; (s.concerns || []).forEach(function (c) { by[c.concern] = c.score; });
        var q = s.quality || {}, l = s.lighting || {};
        return [s.tester, s.scan_id, s.at, s.date, s.day, s.engine, s.skin_score, s.skin_type, s.confidence].concat(M.map(function (k) { return by[k] == null ? '' : by[k]; }))
          .concat([(s.not_measured || []).join('|'), (q.issues || []).join('|'), q.sharpness, q.noise, q.skin_l, l.mean_luma, l.color_temp, s.photo ? 'yes' : '']);
      });
      var csv = [head].concat(rows).map(function (row) { return row.map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'pulse-web-test-scans.csv'; a.click();
    });
  });

  try { key = sessionStorage.getItem('pulse_webtest_admin'); } catch (e) {}
  if (key) api('admin.check').then(function (r) { if (r.ok) { emailConfigured = r.email_configured; open(); } else key = null; });
})();
