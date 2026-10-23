/*
  motion.js: the dashboard's motion, built only on browser features
  (the Web Animations API and requestAnimationFrame). No animation library.

  app.js calls these functions:
    LeoMotion.on()                  true when the browser can animate and reduced motion is off
    LeoMotion.count(from, to, onUpdate, onDone)
                                    tween a number (KPI count-ups); returns { stop() }
    LeoMotion.fadeIn(el)            a short opacity lift (table page changes)
    LeoMotion.rise(el)              fade and rise (start screen coming back)
    LeoMotion.entrance()            the dashboard's first arrival

  Durations stay inside a crisp UI budget and use a strong ease-out. Every
  function is safe to call when motion is off: numbers land on their final
  value and nothing moves.

  Original code for Leo's starter. MIT licence, see LICENSE.
*/
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var canAnimate = typeof Element !== "undefined" && "animate" in Element.prototype;
  var EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  function on() { return canAnimate && !reduce.matches; }

  // Exponential ease-out for number tweens (matches the CSS curve closely).
  function expoOut(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  function rise(el, delay, distance, axis) {
    if (!el) return;
    var from = axis === "x" ? "translateX(" + distance + "px)" : "translateY(" + distance + "px)";
    el.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }],
      { duration: 380, delay: delay, easing: EASE_OUT, fill: "backwards" });
  }

  window.LeoMotion = {
    on: on,

    count: function (from, to, onUpdate, onDone) {
      if (!on()) { onDone(); return { stop: function () {} }; }
      var start = performance.now(), duration = 600, raf = 0;
      function frame(now) {
        var t = Math.min(1, (now - start) / duration);
        onUpdate(from + (to - from) * expoOut(t));
        if (t < 1) raf = requestAnimationFrame(frame); else onDone();
      }
      raf = requestAnimationFrame(frame);
      return { stop: function () { cancelAnimationFrame(raf); } };
    },

    fadeIn: function (el) {
      if (!on() || !el) return;
      el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: "ease" });
    },

    rise: function (el) {
      if (!on() || !el) return;
      rise(el, 0, 8);
    },

    entrance: function () {
      if (!on()) return;
      var q = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
      q(".controls fieldset, .controls .types").forEach(function (el, i) { rise(el, i * 40, -8, "x"); });
      q(".kpi").forEach(function (el, i) { rise(el, 40 + i * 50, 10); });
      q(".charts .panel").forEach(function (el, i) { rise(el, 100 + i * 60, 12); });
      q(".table-panel").forEach(function (el) { rise(el, 180, 12); });
    }
  };
})();
