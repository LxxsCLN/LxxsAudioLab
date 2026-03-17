// Service worker – tracks media across all tabs + manages the audio focus stack.

// --- Media tracking ---
const tabMedia = new Map();
const connectedPorts = [];

// --- Audio metrics (from AudioWorklet) ---
// Map of "tabId:src" → { rmsDb, peakDb, rms, peak, channelCount, sampleRate }
const audioMetrics = new Map();
let metricsThrottleTimer = null;

// --- Audio focus stack ---
let audioStack = [];
let audioStackEnabled = true;

// --- Overlay state ---
let overlayVisible = false;

// --- Normalization state ---
let normalizeEnabled = false;
let targetDb = -14;

// --- Helpers ---

function getAllMedia() {
  const allMedia = [];
  const seen = new Set();
  for (const [tabId, data] of tabMedia) {
    data.media.forEach((m) => {
      const key = `${tabId}:${m.src}`;
      if (seen.has(key)) return;
      seen.add(key);
      const metrics = audioMetrics.get(`${tabId}:${m.src}`) || null;
      allMedia.push({ ...m, tabId, tabTitle: data.tabTitle, tabUrl: data.tabUrl, metrics });
    });
  }
  return allMedia;
}

function broadcast(message) {
  for (const port of connectedPorts) {
    try {
      port.postMessage(message);
    } catch (_) {}
  }
}

function broadcastAllMedia() {
  const allMedia = getAllMedia();
  broadcast({ type: "all-media", media: allMedia });
  broadcastOverlay();
}

function broadcastStack() {
  broadcast({
    type: "audio-stack",
    stack: audioStack.map((entry) => ({ ...entry })),
    enabled: audioStackEnabled,
  });
}

function broadcastOverlay() {
  const allMedia = getAllMedia();
  // Send to all tabs so their overlay updates.
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "overlay-update",
        media: allMedia,
      }).catch(() => {});
    }
  });
}

function broadcastNormalize() {
  // Send to all tabs (worklets).
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "set-normalize",
        enabled: normalizeEnabled,
      }).catch(() => {});
    }
  });
  // Sync to popup and overlay.
  broadcast({ type: "normalize-state", enabled: normalizeEnabled, targetDb });
}

function broadcastTargetDb() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "set-target-db",
        value: targetDb,
      }).catch(() => {});
    }
  });
  broadcast({ type: "normalize-state", enabled: normalizeEnabled, targetDb });
}

function jumpToTab(tabId) {
  chrome.tabs.update(tabId, { active: true });
  chrome.tabs.get(tabId, (tab) => {
    if (tab?.windowId) {
      chrome.windows.update(tab.windowId, { focused: true });
    }
  });
}

// --- Stack operations ---

function pushAudioFocus(tabId, src, name) {
  if (!audioStackEnabled) return;

  const top = audioStack[audioStack.length - 1];
  if (top && top.tabId === tabId && top.src === src) return;

  audioStack = audioStack.filter((e) => !(e.tabId === tabId && e.src === src));

  if (audioStack.length > 0) {
    const prev = audioStack[audioStack.length - 1];
    chrome.tabs.sendMessage(prev.tabId, {
      type: "pause-media",
      src: prev.src,
      fromStack: true,
    }).catch(() => {
      audioStack = audioStack.filter((e) => e.tabId !== prev.tabId);
    });
  }

  audioStack.push({ tabId, src, name });
  broadcastStack();
}

function popAudioFocus(tabId, src) {
  if (!audioStackEnabled) return;

  const idx = audioStack.findIndex(
    (e) => e.tabId === tabId && (e.src === src || !src)
  );
  if (idx === -1) return;

  const wasOnTop = idx === audioStack.length - 1;
  audioStack.splice(idx, 1);

  if (wasOnTop && audioStack.length > 0) {
    const next = audioStack[audioStack.length - 1];
    chrome.tabs.sendMessage(next.tabId, {
      type: "resume-media",
      src: next.src,
      fromStack: true,
    }).catch(() => {
      audioStack = audioStack.filter((e) => e.tabId !== next.tabId);
      if (audioStack.length > 0) {
        const fallback = audioStack[audioStack.length - 1];
        chrome.tabs.sendMessage(fallback.tabId, {
          type: "resume-media",
          src: fallback.src,
          fromStack: true,
        }).catch(() => {});
      }
    });
  }

  broadcastStack();
}

// --- Enforce single playback when stack is enabled ---

function enforceStackOnEnable() {
  audioStack = [];
  const allPlaying = [];
  for (const [tabId, data] of tabMedia) {
    data.media.forEach((m) => {
      if (!m.paused && !m.muted) {
        allPlaying.push({ tabId, src: m.src, name: m.name });
      }
    });
  }
  if (allPlaying.length > 0) {
    const keeper = allPlaying[allPlaying.length - 1];
    for (const entry of allPlaying) {
      if (entry.tabId === keeper.tabId && entry.src === keeper.src) continue;
      chrome.tabs.sendMessage(entry.tabId, {
        type: "pause-media",
        src: entry.src,
        fromStack: true,
      }).catch(() => {});
      audioStack.push(entry);
    }
    audioStack.push(keeper);
  }
}

// --- Keyboard shortcuts ---

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-playback") {
    const top = audioStack[audioStack.length - 1];
    if (top) {
      const tabData = tabMedia.get(top.tabId);
      const mediaEntry = tabData?.media.find((m) => m.src === top.src);
      const isPaused = mediaEntry ? mediaEntry.paused : false;

      chrome.tabs.sendMessage(top.tabId, {
        type: isPaused ? "resume-media" : "pause-media",
        src: top.src,
      }).catch(() => {});
    } else {
      let found = false;
      for (const [tabId, data] of tabMedia) {
        const playing = data.media.find((m) => !m.paused);
        if (playing) {
          chrome.tabs.sendMessage(tabId, {
            type: "pause-media",
            src: playing.src,
          }).catch(() => {});
          found = true;
          break;
        }
      }
      if (!found) {
        for (const [tabId, data] of tabMedia) {
          const paused = data.media.find((m) => m.paused);
          if (paused) {
            chrome.tabs.sendMessage(tabId, {
              type: "resume-media",
              src: paused.src,
            }).catch(() => {});
            break;
          }
        }
      }
    }
  }

  if (command === "jump-to-playing") {
    const top = audioStack[audioStack.length - 1];
    if (top) {
      jumpToTab(top.tabId);
    } else {
      for (const [tabId, data] of tabMedia) {
        if (data.media.some((m) => !m.paused)) {
          jumpToTab(tabId);
          break;
        }
      }
    }
  }
});

// --- Port handling (popup) ---

chrome.runtime.onConnect.addListener((port) => {
  connectedPorts.push(port);

  port.onMessage.addListener((msg) => {
    if (msg.type === "get-all-media") {
      broadcastAllMedia();
      broadcastStack();
    }
    if (msg.type === "toggle-audio-stack") {
      audioStackEnabled = msg.enabled;
      if (audioStackEnabled) {
        enforceStackOnEnable();
      } else {
        audioStack = [];
      }
      broadcastStack();
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "overlay-settings",
            stackEnabled: audioStackEnabled,
          }).catch(() => {});
        }
      });
    }
    if (msg.type === "jump-to-tab") {
      jumpToTab(msg.tabId);
    }
    if (msg.type === "toggle-media") {
      const { tabId, src, action } = msg;
      chrome.tabs.sendMessage(tabId, {
        type: action === "pause" ? "pause-media" : "resume-media",
        src,
      }).catch(() => {});
    }
    if (msg.type === "set-setting-from-popup") {
      if (msg.key === "normalize") {
        normalizeEnabled = msg.value;
        broadcastNormalize();
      }
      if (msg.key === "target-db") {
        targetDb = msg.value;
        broadcastTargetDb();
      }
    }
    if (msg.type === "get-overlay-state") {
      port.postMessage({ type: "overlay-state", visible: overlayVisible });
      port.postMessage({ type: "normalize-state", enabled: normalizeEnabled, targetDb });
    }
    if (msg.type === "set-overlay-visible") {
      overlayVisible = msg.visible;
      // Tell all tabs to show/hide the overlay.
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "set-overlay-display",
            visible: overlayVisible,
          }).catch(() => {});
        }
      });
      // Sync back to any open popups.
      broadcast({ type: "overlay-state", visible: overlayVisible });
    }
  });

  port.onDisconnect.addListener(() => {
    const idx = connectedPorts.indexOf(port);
    if (idx !== -1) connectedPorts.splice(idx, 1);
  });
});

// --- Message handling from content scripts + overlay ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  // --- Overlay requests ---
  if (message.type === "get-all-media-from-content") {
    sendResponse({
      media: getAllMedia(),
      stackEnabled: audioStackEnabled,
      overlayVisible: overlayVisible,
      normalizeEnabled: normalizeEnabled,
      targetDb: targetDb,
    });
    return true;
  }

  if (message.type === "audio-metrics") {
    const key = `${tabId}:${message.src}`;
    audioMetrics.set(key, message.metrics);
    // Throttle: only broadcast metrics updates ~4 times/sec.
    if (!metricsThrottleTimer) {
      metricsThrottleTimer = setTimeout(() => {
        metricsThrottleTimer = null;
        broadcastAllMedia();
      }, 250);
    }
    return;
  }

  if (message.type === "jump-to-tab-from-content") {
    jumpToTab(message.tabId);
    return;
  }

  if (message.type === "toggle-media-from-content") {
    chrome.tabs.sendMessage(message.tabId, {
      type: message.action === "pause" ? "pause-media" : "resume-media",
      src: message.src,
    }).catch(() => {});
    return;
  }

  if (message.type === "set-overlay-visible") {
    overlayVisible = message.visible;
    // Broadcast to all tabs.
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "set-overlay-display",
          visible: overlayVisible,
        }).catch(() => {});
      }
    });
    return;
  }

  if (message.type === "set-setting") {
    if (message.key === "audio-stack") {
      audioStackEnabled = message.value;
      if (audioStackEnabled) {
        enforceStackOnEnable();
      } else {
        audioStack = [];
      }
      broadcastStack();
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "overlay-settings",
            stackEnabled: audioStackEnabled,
          }).catch(() => {});
        }
      });
    }
    if (message.key === "normalize") {
      normalizeEnabled = message.value;
      broadcastNormalize();
    }
    if (message.key === "target-db") {
      targetDb = message.value;
      broadcastTargetDb();
    }
    return;
  }

  // --- Media detection from content script ---
  if (message.type === "media-detected") {
    tabMedia.set(tabId, {
      media: message.media,
      tabTitle: sender.tab.title || "Unknown Tab",
      tabUrl: sender.tab.url || "",
    });
    broadcastAllMedia();
  }

  if (message.type === "media-play") {
    const existing = tabMedia.get(tabId);
    if (existing) {
      const idx = existing.media.findIndex((m) => m.src === message.media.src);
      if (idx !== -1) {
        existing.media[idx] = message.media;
      } else {
        existing.media.push(message.media);
      }
    } else {
      tabMedia.set(tabId, {
        media: [message.media],
        tabTitle: sender.tab.title || "Unknown Tab",
        tabUrl: sender.tab.url || "",
      });
    }
    broadcastAllMedia();
    pushAudioFocus(tabId, message.media.src, message.media.name);
  }

  if (message.type === "media-pause") {
    const existing = tabMedia.get(tabId);
    if (existing) {
      const idx = existing.media.findIndex((m) => m.src === message.media.src);
      if (idx !== -1) {
        existing.media[idx] = message.media;
      }
    }
    broadcastAllMedia();
    popAudioFocus(tabId, message.media.src);
  }

  if (message.type === "media-removed") {
    tabMedia.delete(tabId);
    for (const key of audioMetrics.keys()) {
      if (key.startsWith(`${tabId}:`)) audioMetrics.delete(key);
    }
    broadcastAllMedia();
    const hadEntries = audioStack.some((e) => e.tabId === tabId);
    audioStack = audioStack.filter((e) => e.tabId !== tabId);
    if (hadEntries) {
      if (audioStack.length > 0) {
        const top = audioStack[audioStack.length - 1];
        chrome.tabs.sendMessage(top.tabId, {
          type: "resume-media",
          src: top.src,
          fromStack: true,
        }).catch(() => {});
      }
      broadcastStack();
    }
  }
});

// Clean up when a tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  // Clean up metrics for this tab.
  for (const key of audioMetrics.keys()) {
    if (key.startsWith(`${tabId}:`)) audioMetrics.delete(key);
  }
  const hadEntries = audioStack.some((e) => e.tabId === tabId);
  audioStack = audioStack.filter((e) => e.tabId !== tabId);

  broadcastAllMedia();

  if (hadEntries) {
    if (audioStack.length > 0) {
      const top = audioStack[audioStack.length - 1];
      chrome.tabs.sendMessage(top.tabId, {
        type: "resume-media",
        fromStack: true,
        src: top.src,
      }).catch(() => {});
    }
    broadcastStack();
  }
});
