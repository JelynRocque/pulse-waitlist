/*
 * Pulse "Find My Shade" (v4: shade match, no camera).
 *
 * The person holds their phone against their jawline in a mirror (in
 * daylight) and the screen fills with one gemstone color at a time. They say
 * whether their skin is lighter, deeper or a match, and the next color jumps
 * halfway toward their answer, so any of the ten gemstones is reached in about
 * four taps. When they land between two gemstones, both are shown side by side
 * and they pick the closer one.
 *
 * Why no camera: v3 measured cheek skin against the whites of the eyes. Tested
 * Oct 22, 2026 on a friend (deep skin, glasses, indoor light) it said
 * Moonstone, and on the Monk Skin Tone Examples set (Google/TONL, 19 people
 * rated by Dr. Ellis Monk, testing use) it was off by two or more gemstones
 * about two times in three and read deeper skin as lighter. Phone cameras
 * re-expose every face and the eye whites are too small, shaded and easily
 * blocked by lids, lashes or glasses to fix that. Comparing against the
 * gemstone colors themselves, the references the gemstones are defined by,
 * works the same for every skin tone.
 *
 * The colors are the gemstone swatches already on the page (each radio's <i>
 * swatch), so the finder always shows exactly the colors people pick from.
 * Nothing is recorded; only the shade the person picks is submitted, the same
 * as tapping it by hand.
 *
 * Use: add a button with data-shade-finder="<radio name>" next to a group of
 * ten shade radios, lightest first. Each radio's label needs an <i> swatch and
 * the shade name as text. Radios with value "prefer_not" are skipped.
 */
(function () {
  "use strict";

  var GEMSTONES = 10;
  var FIRST = 5; // start in the middle of the row (Tiger's Eye)

  // Next gemstone to show inside the range lo..hi still possible.
  function middle(lo, hi) { return Math.round((lo + hi) / 2); }

  // One answer. state = {lo, hi, cur, steps}. answer: "lighter" | "deeper" | "match".
  // Returns the new state, or {done:true, best, alt, between}.
  function step(state, answer) {
    var lo = state.lo, hi = state.hi, cur = state.cur, steps = (state.steps || 0) + 1;
    if (answer === "match") {
      return { done: true, best: cur, alt: neighbor(cur, state.lastDir), between: false };
    }
    if (answer === "lighter") hi = cur - 1; else lo = cur + 1;
    if (hi < 0) return { done: true, best: 0, alt: 1, between: false };                         // lighter than Pearl
    if (lo > GEMSTONES - 1) return { done: true, best: GEMSTONES - 1, alt: GEMSTONES - 2, between: false }; // deeper than Onyx
    if (lo > hi) {
      // Lighter than one gemstone and deeper than the one next to it: compare those two.
      var a = Math.min(lo, hi), b = Math.max(lo, hi);
      return { done: false, pair: [a, b], steps: steps };
    }
    var next = middle(lo, hi);
    return { done: false, lo: lo, hi: hi, cur: next, steps: steps, lastDir: answer };
  }
  function neighbor(i, lastDir) {
    if (i === 0) return 1;
    if (i === GEMSTONES - 1) return GEMSTONES - 2;
    return lastDir === "lighter" ? i + 1 : i - 1;
  }

  // ---------- Styles ----------
  var CSS = "" +
    ".sf-open{font:inherit;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;margin:2px 0 4px;padding:9px 14px;border-radius:999px;border:1px solid var(--espresso,#261000);background:transparent;color:var(--espresso,#261000);cursor:pointer;justify-self:start}" +
    ".sf-open[hidden]{display:none}" +
    ".sf-open:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-open svg{width:16px;height:16px;flex:none}" +
    ".sf-picked{font-size:12px;color:var(--espresso-soft,#5B4436);margin:0}" +
    ".sf-picked:empty{display:none}" +
    "dialog.sf{border:0;padding:0;width:min(440px,100vw);max-width:100vw;max-height:100dvh;border-radius:20px;background:var(--warm-white,#FFFBF7);color:var(--espresso,#261000);font-family:var(--body,Raleway,Arial,sans-serif);box-shadow:0 30px 80px -20px rgba(38,16,0,.6);overflow:hidden}" +
    "dialog.sf::backdrop{background:rgba(38,16,0,.6)}" +
    "@media (max-width:480px){dialog.sf{width:100vw;height:100dvh;max-height:100dvh;border-radius:0;margin:0}}" +
    ".sf-body{padding:22px 22px 24px;display:grid;gap:14px}" +
    ".sf-step{display:grid;gap:14px}" +
    ".sf-head{display:flex;justify-content:space-between;align-items:center;gap:12px}" +
    ".sf h2{font-family:var(--display,Georgia,serif);font-weight:400;font-size:26px;line-height:1.15;margin:0}" +
    ".sf-x{font:inherit;font-size:24px;line-height:1;border:0;background:transparent;color:inherit;cursor:pointer;width:40px;height:40px;border-radius:50%;flex:none}" +
    ".sf-x:hover{background:rgba(127,127,127,.18)}" +
    ".sf p{margin:0;font-size:14px;color:var(--espresso-soft,#5B4436)}" +
    ".sf ul{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:14px}" +
    ".sf li{display:flex;gap:10px;align-items:flex-start}" +
    ".sf li b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--paper,#FFF3E8);color:var(--auburn,#96262C);font-size:12px;display:grid;place-items:center;margin-top:1px}" +
    ".sf-btn{font:inherit;font-weight:700;font-size:15px;letter-spacing:.03em;border:0;border-radius:999px;padding:14px 20px;cursor:pointer;background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7);width:100%}" +
    ".sf-btn:hover{background:var(--auburn,#96262C)}" +
    ".sf-btn.ghost{background:transparent;color:var(--espresso,#261000);border:1px solid var(--espresso,#261000)}" +
    ".sf-btn.ghost:hover{background:var(--espresso,#261000);color:var(--warm-white,#FFFBF7)}" +
    ".sf-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    /* Compare screens: the whole dialog becomes the color */
    "dialog.sf.sf-full .sf-body{padding:0;gap:0;height:100%}" +
    ".sf-cmp{position:relative;display:grid;grid-template-rows:auto 1fr auto;min-height:min(640px,100dvh);height:100%}" +
    ".sf-cmp-top{display:flex;justify-content:space-between;align-items:center;padding:14px 14px 0 20px;gap:12px}" +
    ".sf-cmp-top span{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;padding:6px 10px;border-radius:999px;background:rgba(255,251,247,.86);color:#261000}" +
    ".sf-cmp-top .sf-x{background:rgba(255,251,247,.86);color:#261000}" +
    ".sf-colors{display:grid;grid-auto-flow:column;grid-auto-columns:1fr}" +
    ".sf-colors button{border:0;margin:0;padding:0 0 18px;cursor:pointer;display:flex;align-items:flex-end;justify-content:center;font:inherit;font-weight:700;font-size:15px}" +
    ".sf-colors button span{background:rgba(255,251,247,.92);color:#261000;padding:10px 16px;border-radius:999px}" +
    ".sf-colors div{display:block}" +
    ".sf-ask{background:var(--warm-white,#FFFBF7);padding:16px 18px 20px;display:grid;gap:10px}" +
    ".sf-ask p{text-align:center;color:var(--espresso,#261000);font-size:15px;font-weight:600}" +
    ".sf-ask .sf-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}" +
    ".sf-ask .sf-btn{padding:13px 8px;font-size:14px;letter-spacing:.01em}" +
    ".sf-result{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;background:var(--paper,#FFF3E8);border-radius:16px;padding:16px}" +
    ".sf-result i{width:64px;height:64px;border-radius:50%;display:block;border:3px solid var(--warm-white,#FFFBF7);box-shadow:0 0 0 1px rgba(38,16,0,.12)}" +
    ".sf-result small{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--burnt-orange,#AB5B1E)}" +
    ".sf-result strong{display:block;font-family:var(--display,Georgia,serif);font-weight:400;font-size:28px;line-height:1.1;color:var(--espresso,#261000)}" +
    ".sf-alt{display:flex;align-items:center;gap:10px;font-size:14px}" +
    ".sf-alt i{width:24px;height:24px;border-radius:50%;display:block;border:1px solid rgba(38,16,0,.15);flex:none}" +
    ".sf-alt button{font:inherit;font-weight:600;font-size:14px;color:var(--auburn,#96262C);background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}" +
    ".sf [hidden]{display:none !important}";

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="12" r="3.5"/><circle cx="17" cy="12" r="3.5"/><path d="M10.5 12h3"/></svg>';

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
    trigger.hidden = false;
    var picked = document.getElementById(trigger.getAttribute("aria-describedby") || "") || null;

    var dlg = el("dialog", { "class": "sf", "aria-labelledby": "sfTitle" });
    dlg.innerHTML =
      '<div class="sf-body">' +
        '<div data-step="intro" class="sf-step">' +
          '<div class="sf-head"><h2 id="sfTitle">Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<p>Your screen will fill with one shade at a time. Compare each one with your skin, and you\'ll have your shade in about four taps.</p>' +
          '<ul>' +
            '<li><b>1</b><span>Stand at a mirror facing a window in daylight, out of direct sun.</span></li>' +
            '<li><b>2</b><span>Set your screen brightness to about halfway.</span></li>' +
            '<li><b>3</b><span>Hold your phone flat against your jawline, screen facing the mirror, and compare the color with the skin right next to it. A friend can hold it for you instead.</span></li>' +
          '</ul>' +
          '<button type="button" class="sf-btn" data-start>Start</button>' +
        '</div>' +

        '<div data-step="compare" hidden class="sf-cmp">' +
          '<div class="sf-cmp-top"><span data-progress></span><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<div class="sf-colors" data-colors></div>' +
          '<div class="sf-ask" data-ask>' +
            '<p data-question>Compared with this color, your skin is…</p>' +
            '<div class="sf-row3" data-three><button type="button" class="sf-btn ghost" data-answer="lighter">Lighter</button><button type="button" class="sf-btn" data-answer="match">A Match</button><button type="button" class="sf-btn ghost" data-answer="deeper">Deeper</button></div>' +
          '</div>' +
        '</div>' +

        '<div data-step="result" hidden class="sf-step">' +
          '<div class="sf-head"><h2>Find My Shade</h2><button type="button" class="sf-x" data-close aria-label="Close">&times;</button></div>' +
          '<div class="sf-result"><i data-best-dot></i><div><small>Your Shade</small><strong data-best-name></strong></div></div>' +
          '<p data-note>If another shade feels more like you, pick that one instead.</p>' +
          '<div class="sf-alt"><i data-alt-dot></i><span>Also close: <button type="button" data-use-alt></button></span></div>' +
          '<button type="button" class="sf-btn" data-use-best></button>' +
          '<div class="sf-row"><button type="button" class="sf-btn ghost" data-retry>Start Over</button><button type="button" class="sf-btn ghost" data-close>Pick Myself</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    var q = function (s) { return dlg.querySelector(s); };
    var state = null, result = null, focusAfter = null;

    function show(name) {
      ["intro", "compare", "result"].forEach(function (s) { q('[data-step="' + s + '"]').hidden = s !== name; });
      dlg.classList.toggle("sf-full", name === "compare");
    }

    function begin() {
      state = { lo: 0, hi: GEMSTONES - 1, cur: FIRST, steps: 0 };
      showCompare();
    }

    function showCompare() {
      var colors = q("[data-colors]");
      colors.innerHTML = "";
      var pair = state.pair;
      // Single color fills the whole screen behind the top bar; a pair splits it.
      q('[data-step="compare"]').style.background = pair
        ? "linear-gradient(90deg," + shades[pair[0]].color + " 50%," + shades[pair[1]].color + " 50%)"
        : shades[state.cur].color;
      if (pair) {
        // Final choice between two neighbors: tap the half that blends in better.
        pair.forEach(function (i) {
          var b = el("button", { type: "button", "data-pick": String(i), "aria-label": shades[i].name });
          b.style.background = shades[i].color;
          b.appendChild(el("span", null, shades[i].name));
          colors.appendChild(b);
        });
        q("[data-question]").textContent = "You're between these two. Hold each half to your jawline and tap the closer one.";
        q("[data-three]").hidden = true;
        q("[data-progress]").textContent = "Last step";
      } else {
        var d = el("div", { role: "img", "aria-label": shades[state.cur].name });
        colors.appendChild(d);
        q("[data-question]").textContent = "Compared with this color, your skin is…";
        q("[data-three]").hidden = false;
        q("[data-progress]").textContent = "Shade " + (state.steps + 1);
      }
      show("compare");
      var focusTarget = pair ? colors.querySelector("button") : q('[data-answer="match"]');
      if (focusTarget) focusTarget.focus();
    }

    function answer(a) {
      var next = step(state, a);
      if (next.done) { result = next; showResult(); return; }
      state = next;
      showCompare();
    }

    function pick(i) {
      var other = state.pair[0] === i ? state.pair[1] : state.pair[0];
      result = { best: i, alt: other, between: true };
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
      show("result");
      q("[data-use-best]").focus();
    }

    function choose(shade) {
      shade.input.checked = true;
      shade.input.dispatchEvent(new Event("change", { bubbles: true }));
      if (picked) picked.textContent = "Matched with Find My Shade: " + shade.name + ". Now pick your undertone below. You can change either anytime.";
      focusAfter = shade.input;
      close();
    }

    function open() {
      result = null; state = null;
      show("intro");
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
      document.documentElement.style.overflow = "hidden";
    }
    function close() {
      if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
    }

    dlg.addEventListener("close", function () {
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
      else if (t.hasAttribute("data-start") || t.hasAttribute("data-retry")) begin();
      else if (t.hasAttribute("data-answer")) answer(t.getAttribute("data-answer"));
      else if (t.hasAttribute("data-pick")) pick(parseInt(t.getAttribute("data-pick"), 10));
      else if (t.hasAttribute("data-use-best")) choose(shades[result.best]);
      else if (t.hasAttribute("data-use-alt")) choose(shades[result.alt]);
    });
    trigger.addEventListener("click", open);
    radios.forEach(function (r) { r.addEventListener("change", function (e) { if (e.isTrusted && picked) picked.textContent = ""; }); });
  }

  function init() {
    if (!document.getElementById("sf-style")) {
      var st = el("style", { id: "sf-style" }); st.textContent = CSS; document.head.appendChild(st);
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-shade-finder]"), function (b) {
      if (!b.querySelector("svg")) b.insertAdjacentHTML("afterbegin", ICON);
      setup(b);
    });
  }

  window.PulseShadeFinder = { step: step, FIRST: FIRST, GEMSTONES: GEMSTONES };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
