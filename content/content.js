// Content script – detects <audio>/<video>, reports play/pause, accepts commands.
// Also injects the page script for audio hooking (Phase 2).

// Suppression counter — events are suppressed when > 0.
// Each suppression source (audio hookup, stack commands) increments/decrements independently.
let suppressCount = 0;

function isSuppressed() {
  return suppressCount > 0;
}

function suppress(durationMs) {
  suppressCount++;
  setTimeout(() => { suppressCount = Math.max(0, suppressCount - 1); }, durationMs);
}

// Tracks off-DOM media (WhatsApp voice messages, etc.) that are currently playing.
// These can't be found by querySelectorAll, so we track them separately.
const offDomMedia = new Map();

// Tracks whether the extension context is still valid.
let contextValid = true;

function safeSendMessage(msg) {
  if (!contextValid) return;
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    shutdown();
  }
}

function shutdown() {
  contextValid = false;
  clearInterval(scanInterval);
  observer.disconnect();
  offDomMedia.clear();
  document.removeEventListener("play", onPlay, true);
  document.removeEventListener("pause", onPause, true);
  document.removeEventListener("volumechange", onVolumeChange, true);
  document.removeEventListener("ended", onEnded, true);
}

// --- Inject page script into the page's JS world ---
(function injectPageScript() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page/page-script.js");
  script.dataset.workletUrl = chrome.runtime.getURL("worklet/analyzer-processor.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

// Listen for messages from the page script (audio hooking + metrics).
window.addEventListener("message", (e) => {
  if (e.source !== window) return;

  // Suppress events during audio hookup (createMediaElementSource transients).
  if (e.data.type === "lxxs-hooking-start") {
    suppress(500);
  }

  if (e.data.type === "lxxs-audio-hooked") {
    safeSendMessage({
      type: "audio-hooked",
      src: e.data.src,
      sampleRate: e.data.sampleRate,
      channelCount: e.data.channelCount,
    });
  }

  if (e.data.type === "lxxs-audio-metrics") {
    safeSendMessage({
      type: "audio-metrics",
      src: e.data.src,
      metrics: e.data.metrics,
    });
  }

  // Off-DOM audio playback (WhatsApp voice messages, Slack, etc.)
  if (e.data.type === "lxxs-offdom-play") {
    const entry = {
      tag: "audio",
      src: e.data.src || e.data.id,
      name: `Audio — ${e.data.pageTitle}`,
      paused: false,
      muted: false,
      duration: e.data.duration,
      currentTime: 0,
    };
    offDomMedia.set(entry.src, entry);
    safeSendMessage({ type: "media-play", media: entry });
  }

  if (e.data.type === "lxxs-offdom-pause") {
    const src = e.data.src || e.data.id;
    const entry = offDomMedia.get(src);
    if (entry) {
      entry.paused = true;
      offDomMedia.delete(src);
    }
    safeSendMessage({
      type: "media-pause",
      media: {
        tag: "audio",
        src,
        name: `Audio — ${e.data.pageTitle || document.title}`,
        paused: true,
        muted: false,
        duration: 0,
        currentTime: 0,
      },
    });
  }
});

function getMediaName(el) {
  if (el.title) return el.title;
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");

  const ytTitle = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, h1.title"
  );
  if (ytTitle && ytTitle.textContent.trim()) return ytTitle.textContent.trim();

  return document.title || "Unknown";
}

function describeMedia(el) {
  return {
    tag: el.tagName.toLowerCase(),
    src: el.currentSrc || el.src || "",
    name: getMediaName(el),
    paused: el.paused,
    muted: el.muted || el.volume === 0,
    duration: el.duration || 0,
    currentTime: el.currentTime || 0,
  };
}

function scanForMedia() {
  if (!contextValid) return;
  const elements = document.querySelectorAll("audio, video");
  const found = [];
  const seenSrcs = new Set();

  elements.forEach((el) => {
    if (el.currentSrc || el.src || el.querySelector("source")) {
      if (el.muted || el.volume === 0) return;
      const src = el.currentSrc || el.src || "";
      if (src && seenSrcs.has(src)) return;
      if (src) seenSrcs.add(src);
      found.push(describeMedia(el));
    }
  });

  // Include off-DOM media (WhatsApp voice messages, etc.)
  for (const entry of offDomMedia.values()) {
    found.push(entry);
  }

  if (found.length > 0) {
    safeSendMessage({ type: "media-detected", media: found });
  } else {
    safeSendMessage({ type: "media-removed" });
  }
}

// --- Media element helpers ---

function findMediaBySrc(src) {
  const elements = document.querySelectorAll("audio, video");
  for (const el of elements) {
    if ((el.currentSrc || el.src) === src) return el;
  }
  for (const el of elements) {
    if (!el.paused) return el;
  }
  return elements[0] || null;
}

function findPlayingMedia() {
  const elements = document.querySelectorAll("audio, video");
  for (const el of elements) {
    if (!el.paused) return el;
  }
  return null;
}

// --- Listen for commands from background ---

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!contextValid) return;

    if (msg.type === "pause-media") {
      const el = msg.src ? findMediaBySrc(msg.src) : findPlayingMedia();
      if (el && !el.paused) {
        // Stack-initiated: suppress the resulting pause event so it doesn't
        // trigger popAudioFocus (the stack already knows about this).
        if (msg.fromStack) suppress(300);
        el.pause();
      }
    }

    if (msg.type === "resume-media") {
      const el = msg.src ? findMediaBySrc(msg.src) : findMediaBySrc("");
      if (el && el.paused) {
        if (msg.fromStack) suppress(300);
        el.play().catch(() => {});
      }
    }

    // Normalization commands — forward to the page script.
    if (msg.type === "set-normalize") {
      window.postMessage({ type: "lxxs-set-normalize", enabled: msg.enabled }, "*");
    }
    if (msg.type === "set-target-db") {
      window.postMessage({ type: "lxxs-set-target-db", value: msg.value }, "*");
    }
  });
} catch {
  shutdown();
}

// --- Detect play/pause events ---

scanForMedia();

const observer = new MutationObserver(() => scanForMedia());
observer.observe(document.body, { childList: true, subtree: true });
const scanInterval = setInterval(scanForMedia, 3000);

function onPlay(e) {
  if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
    if (!contextValid || isSuppressed()) return;
    const el = e.target;
    if (el.muted || el.volume === 0) return;
    const info = describeMedia(el);
    safeSendMessage({ type: "media-play", media: info });
  }
}

function onPause(e) {
  if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
    if (!contextValid || isSuppressed()) return;
    const info = describeMedia(e.target);
    safeSendMessage({ type: "media-pause", media: info });
  }
}

function onVolumeChange(e) {
  if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
    if (!contextValid || isSuppressed()) return;
    const el = e.target;
    const info = describeMedia(el);
    if (el.muted || el.volume === 0) {
      if (!el.paused) {
        safeSendMessage({ type: "media-pause", media: info });
      }
    } else {
      if (!el.paused) {
        safeSendMessage({ type: "media-play", media: info });
      }
    }
  }
}

function onEnded(e) {
  if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
    if (!contextValid) return;
    const info = describeMedia(e.target);
    safeSendMessage({ type: "media-pause", media: info });
  }
}

document.addEventListener("play", onPlay, true);
document.addEventListener("pause", onPause, true);
document.addEventListener("volumechange", onVolumeChange, true);
document.addEventListener("ended", onEnded, true);
