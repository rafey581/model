/*
 * quality-boot.js — runs before any module, so <html data-quality> is set for both the
 * CSS tier rules and game/qualityConfig.ts to read, and so the tab-hidden pause class
 * exists from the first paint.
 *
 * The detection ladder below is mirrored verbatim in src/game/qualityConfig.ts
 * (detectQualityTier) — keep the two comment blocks identical when either changes:
 *
 *   - mobile user agent .................... low
 *   - phone-sized screen with dpr >= 2 ..... low   (webviews and small windows)
 *   - hardwareConcurrency <= 4 or
 *     deviceMemory <= 4 .................... medium
 *   - integrated or software GPU ........... medium  (cores say nothing about fill rate)
 *   - dpr >= 2.5 on a <= 6-core or
 *     <= 6GB device ....................... medium  (many pixels on a weak GPU)
 *   - otherwise ............................ high
 */
;(function () {
  try {
    // Same pattern and same probe as hasWeakGpu() in src/game/qualityConfig.ts.
    var weakGpu = function () {
      try {
        var gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return false
        var info = gl.getExtension('WEBGL_debug_renderer_info')
        var name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '')
        var lose = gl.getExtension('WEBGL_lose_context')
        if (lose) lose.loseContext()
        return /Intel(?!.*Arc)|Radeon\(TM\) Graphics|Radeon.*Vega|SwiftShader|llvmpipe|Basic Render/i.test(name)
      } catch (e) {
        return false
      }
    }
    var tier = null
    var asked = new URLSearchParams(location.search).get('quality')
    if (asked === 'low' || asked === 'medium' || asked === 'high') tier = asked
    if (!tier) {
      // The player's own choice from Settings (QUALITY_STORAGE_KEY in qualityConfig.ts).
      // Absent means "auto", which is the device guess below.
      try {
        var saved = localStorage.getItem('snooker.quality')
        if (saved === 'low' || saved === 'medium' || saved === 'high') tier = saved
      } catch (e) {
        /* Storage refused: fall through to the guess. */
      }
    }
    if (!tier) {
      var mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent)
      var cores = navigator.hardwareConcurrency || 8
      var mem = navigator.deviceMemory || 8
      var dpr = window.devicePixelRatio || 1
      var smallScreen = window.screen ? Math.min(window.screen.width, window.screen.height) < 760 : false
      if (mobileUA) tier = 'low'
      else if (smallScreen && dpr >= 2) tier = 'low'
      else if (cores <= 4 || mem <= 4) tier = 'medium'
      else if (weakGpu()) tier = 'medium'
      else if (dpr >= 2.5 && (cores <= 6 || mem <= 6)) tier = 'medium'
      else tier = 'high'
    }
    document.documentElement.dataset.quality = tier

    // The pause switch for decorative motion: while the tab is hidden the CSS stops
    // every animation and the page stops trying to be anywhere in particular.
    var sync = function () {
      if (document.hidden) document.documentElement.setAttribute('data-hidden', '')
      else document.documentElement.removeAttribute('data-hidden')
    }
    document.addEventListener('visibilitychange', sync)
    sync()
  } catch (e) {
    /* No document or location: the CSS falls back to its default tier. */
  }
})()
