/*
 * Hands Find My Shade readings to the Pulse app. The app's web view receives JSON through
 * window.ReactNativeWebView.postMessage; in a normal browser (tests) messages go to window.parent and are kept in
 * window.__pulseMessages.
 */
(function () {
  "use strict";
  var trigger = document.querySelector("[data-shade-finder]");
  window.__pulseMessages = [];

  function post(msg) {
    window.__pulseMessages.push(msg);
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) window.ReactNativeWebView.postMessage(s);
    else if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
  }

  // CIELAB (D65) -> sRGB hex, for the "your skin as the camera read it" swatch on A18.
  function labToHex(lab) {
    if (!lab || lab.some(function (v) { return typeof v !== "number" || !isFinite(v); })) return null;
    var fy = (lab[0] + 16) / 116, fx = fy + lab[1] / 500, fz = fy - lab[2] / 200;
    function inv(t) { return t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787; }
    var X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    var rgb = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z];
    return "#" + rgb.map(function (v) {
      v = Math.max(0, Math.min(1, v));
      v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      return ("0" + Math.round(v * 255).toString(16)).slice(-2);
    }).join("").toUpperCase();
  }
  window.__labToHex = labToHex;

  if (!trigger || !window.PulseShadeFinder) { post({ type: "error", reason: "finder_unavailable" }); return; }

  trigger.addEventListener("pulseshadefinder:result", function (e) {
    e.preventDefault();
    var d = e.detail || {};
    // Skin sits in the red-yellow quarter of color space; a green or blue cast is the room's light, not the skin.
    var lab = d.lab ? [d.lab[0], Math.max(0, d.lab[1]), Math.max(0, d.lab[2])] : null;
    post({ type: "result", gemstone: d.gemstone, alt: d.alt, close: !!d.close, depth: Math.round(d.depth * 10) / 10, measuredHex: labToHex(lab), source: d.source === "skin" ? "skin" : "eyes" });
  });
  trigger.addEventListener("pulseshadefinder:close", function (e) {
    if (!(e.detail && e.detail.handedOff)) post({ type: "cancel" });
  });

  document.querySelector("[data-start-again]").addEventListener("click", function () { trigger.click(); });
  document.querySelector("[data-back]").addEventListener("click", function () { post({ type: "cancel" }); });

  // Open the finder straight away; the camera only starts after the person agrees and taps Start Camera.
  trigger.click();
})();
