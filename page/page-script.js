// Page script — runs in the page's JS context (not the extension's).
// Hooks into media elements and builds the Web Audio processing chain.

(function () {
  // Track which elements we've already hooked so we don't double-hook.
  const hookedElements = new WeakSet();

  // Store references to audio chains for cleanup.
  const audioChains = new WeakMap();

  // The worklet URL is passed from the content script via the script element's dataset.
  const scriptEl = document.currentScript;
  const workletUrl = scriptEl ? scriptEl.dataset.workletUrl : null;

  // Pre-built AudioContext with worklet already loaded, so hooking is synchronous.
  let sharedCtx = null;
  let workletReady = false;

  async function ensureContext() {
    if (sharedCtx && sharedCtx.state !== "closed") return;
    sharedCtx = new AudioContext();
    if (workletUrl) {
      try {
        await sharedCtx.audioWorklet.addModule(workletUrl);
        workletReady = true;
      } catch (err) {
        console.warn("[LxxsAudioLab] AudioWorklet failed:", err.message);
        workletReady = false;
      }
    }
  }

  // Pre-load the context as early as possible.
  ensureContext();

  function hookMediaElement(el) {
    if (hookedElements.has(el)) return;
    hookedElements.add(el);

    // Don't hook muted/silent elements.
    if (el.muted || el.volume === 0) return;

    // Wait for the element to have a source.
    if (!el.currentSrc && !el.src) return;

    // Tell the content script to ignore events during hookup.
    window.postMessage({ type: "lxxs-hooking-start" }, "*");

    try {
      const ctx = sharedCtx || new AudioContext();

      // Resume if suspended (Chrome requires user gesture).
      if (ctx.state === "suspended") {
        ctx.resume();
      }

      // createMediaElementSource captures the element's audio output.
      // IMPORTANT: This can only be called ONCE per element.
      let source;
      try {
        source = ctx.createMediaElementSource(el);
      } catch (err) {
        console.warn("[LxxsAudioLab] Could not capture media element:", err.message);
        return;
      }

      // GainNode — will be used for normalization in Phase 4.
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;

      // AudioWorkletNode — computes metrics in Phase 3.
      let analyzerNode = null;
      if (workletReady) {
        try {
          analyzerNode = new AudioWorkletNode(ctx, "analyzer-processor");

          analyzerNode.port.onmessage = (e) => {
            window.postMessage({
              type: "lxxs-audio-metrics",
              src: el.currentSrc || el.src,
              metrics: e.data,
            }, "*");
          };
        } catch (err) {
          console.warn("[LxxsAudioLab] AudioWorkletNode creation failed:", err.message);
        }
      }

      // Wire the chain synchronously — no async gaps where audio could drop.
      // source → gainNode → analyzerNode → destination
      source.connect(gainNode);
      if (analyzerNode) {
        gainNode.connect(analyzerNode);
        analyzerNode.connect(ctx.destination);
      } else {
        gainNode.connect(ctx.destination);
      }

      // Store references for potential cleanup.
      audioChains.set(el, { ctx, source, gainNode, analyzerNode });

      const name = el.title || el.getAttribute("aria-label") || document.title || "Unknown";
      console.log(`[LxxsAudioLab] Audio chain created for: ${name}`);
      console.log(`[LxxsAudioLab] Sample rate: ${ctx.sampleRate}Hz, State: ${ctx.state}`);

      // Notify the content script that hooking succeeded.
      window.postMessage({
        type: "lxxs-audio-hooked",
        src: el.currentSrc || el.src,
        sampleRate: ctx.sampleRate,
        channelCount: el.mozChannelCount || 2,
      }, "*");

      // Handle context resumption when tab becomes visible again.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && ctx.state === "suspended") {
          ctx.resume();
        }
      });

    } catch (err) {
      console.error("[LxxsAudioLab] Failed to hook media element:", err);
    }
  }

  // --- Scan and hook ---

  function scanAndHook() {
    const elements = document.querySelectorAll("audio, video");
    elements.forEach((el) => {
      if (!el.paused && !el.muted && el.volume > 0 && (el.currentSrc || el.src)) {
        hookMediaElement(el);
      }
    });
  }

  // Hook on play events — guarantees a user gesture has occurred.
  document.addEventListener("play", (e) => {
    if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
      const el = e.target;
      if (!el.muted && el.volume > 0) {
        // Ensure context is ready, then hook.
        ensureContext().then(() => hookMediaElement(el));
      }
    }
  }, true);

  // Hook when a muted element gets unmuted.
  document.addEventListener("volumechange", (e) => {
    if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
      const el = e.target;
      if (!el.paused && !el.muted && el.volume > 0) {
        ensureContext().then(() => hookMediaElement(el));
      }
    }
  }, true);

  // Initial scan.
  scanAndHook();

  // --- Normalization commands from content script ---
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    if (e.data.type === "lxxs-set-normalize") {
      // Forward to all hooked AudioWorklet nodes.
      const elements = document.querySelectorAll("audio, video");
      elements.forEach((el) => {
        const chain = audioChains.get(el);
        if (chain && chain.analyzerNode) {
          chain.analyzerNode.port.postMessage({
            type: "set-normalize",
            enabled: e.data.enabled,
          });
        }
      });
    }

    if (e.data.type === "lxxs-set-target-db") {
      const elements = document.querySelectorAll("audio, video");
      elements.forEach((el) => {
        const chain = audioChains.get(el);
        if (chain && chain.analyzerNode) {
          chain.analyzerNode.port.postMessage({
            type: "set-target-db",
            value: e.data.value,
          });
        }
      });
    }
  });

  // --- Off-DOM media interception ---
  // Some apps (WhatsApp, Slack, etc.) play audio via `new Audio(url)` which
  // creates an element that's never added to the DOM. Our querySelectorAll
  // can't find it. We intercept HTMLMediaElement.prototype.play to catch these.

  const trackedOffDom = new WeakSet();
  let offDomIdCounter = 0;

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const el = this;
    const inDom = el.isConnected;

    // Only intercept off-DOM elements — in-DOM ones are handled by the content script.
    if (!inDom && !trackedOffDom.has(el)) {
      trackedOffDom.add(el);
      const id = `offdom-${offDomIdCounter++}`;
      el._lxxsId = id;

      // Wait for metadata to get duration, then report.
      const report = () => {
        // Skip very short sounds (< 1s) and muted elements.
        if (el.duration && el.duration < 1) return;
        if (el.muted || el.volume === 0) return;

        window.postMessage({
          type: "lxxs-offdom-play",
          id,
          duration: el.duration || 0,
          src: el.currentSrc || el.src || id,
          pageTitle: document.title || "Unknown",
        }, "*");
      };

      if (el.readyState >= 1) {
        report();
      } else {
        el.addEventListener("loadedmetadata", report, { once: true });
      }

      el.addEventListener("pause", () => {
        window.postMessage({
          type: "lxxs-offdom-pause",
          id,
          src: el.currentSrc || el.src || id,
          pageTitle: document.title || "Unknown",
        }, "*");
      });

      el.addEventListener("ended", () => {
        window.postMessage({
          type: "lxxs-offdom-pause",
          id,
          src: el.currentSrc || el.src || id,
          pageTitle: document.title || "Unknown",
        }, "*");
      });

      // Also detect play after pause (re-play).
      el.addEventListener("play", () => {
        if (el.muted || el.volume === 0) return;
        window.postMessage({
          type: "lxxs-offdom-play",
          id: el._lxxsId,
          duration: el.duration || 0,
          src: el.currentSrc || el.src || el._lxxsId,
          pageTitle: document.title || "Unknown",
        }, "*");
      });
    }

    return origPlay.apply(this, args);
  };

  console.log("[LxxsAudioLab] Page script loaded — ready to hook audio.");
})();
