// Popup – shows media from all tabs + the audio focus stack.

const statusEl = document.getElementById("status");
const listEl = document.getElementById("media-list");
const stackListEl = document.getElementById("stack-list");
const stackToggle = document.getElementById("stack-toggle");

const overlayToggle = document.getElementById("overlay-toggle");
const normalizeToggle = document.getElementById("normalize-toggle");
const targetDbSlider = document.getElementById("target-db-slider");
const targetDbRow = document.getElementById("target-db-row");
const targetDbValue = document.getElementById("target-db-value");

const port = chrome.runtime.connect({ name: "popup" });
port.postMessage({ type: "get-all-media" });
port.postMessage({ type: "get-overlay-state" });

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

// --- Stack rendering ---

function renderStack(stack, enabled) {
  stackToggle.checked = enabled;
  stackListEl.innerHTML = "";

  if (!enabled) {
    stackListEl.innerHTML = `<div class="stack-disabled">Disabled — all tabs play independently</div>`;
    return;
  }

  if (!stack || stack.length === 0) {
    stackListEl.innerHTML = `<div class="stack-empty">No audio in the stack</div>`;
    return;
  }

  // Render bottom to top (bottom of stack = first pushed).
  stack.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "stack-entry";

    const isTop = i === stack.length - 1;
    const marker = isTop ? ">" : (i + 1).toString();

    div.innerHTML = `
      <span class="stack-pos">${marker}</span>
      <span class="stack-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
    `;

    stackListEl.appendChild(div);
  });
}

// --- Media list rendering ---

function renderMedia(mediaList) {
  listEl.innerHTML = "";

  if (!mediaList || mediaList.length === 0) {
    statusEl.textContent = "No media playing across any tab.";
    listEl.innerHTML = `
      <div class="empty-state">
        No audio or video detected.<br/>
        Try playing something on YouTube, Spotify, or any site with media.
      </div>
    `;
    return;
  }

  statusEl.textContent = `${mediaList.length} media element(s) across ${countTabs(mediaList)} tab(s)`;

  const grouped = new Map();
  mediaList.forEach((m) => {
    const key = m.tabId;
    if (!grouped.has(key)) {
      grouped.set(key, { tabTitle: m.tabTitle, tabUrl: m.tabUrl, items: [] });
    }
    grouped.get(key).items.push(m);
  });

  grouped.forEach((group, tabId) => {
    const section = document.createElement("div");
    section.className = "tab-group";

    const domain = getDomain(group.tabUrl);
    const label = domain ? `${domain} — ${group.tabTitle}` : group.tabTitle;

    section.innerHTML = `<div class="tab-header" title="${escapeHtml(group.tabTitle)}">${escapeHtml(label)}</div>`;

    group.items.forEach((m) => {
      const card = document.createElement("div");
      card.className = "media-card";
      card.title = "Click to jump to this tab";

      const stateClass = m.paused ? "paused" : "playing";
      const stateLabel = m.paused ? "Paused" : "Playing";
      const btnLabel = m.paused ? "Play" : "Pause";

      let classLabel = "";
      let classCss = "classification";
      let dbDisplay = "";
      if (m.metrics && !m.paused) {
        const db = m.metrics.smoothedDb ?? m.metrics.rmsDb;
        if (db <= -60) { classLabel = "Silent"; classCss = "classification silent"; }
        else if (db <= -30) { classLabel = "Quiet"; classCss = "classification quiet"; }
        else if (db <= -10) { classLabel = "Normal"; classCss = "classification normal"; }
        else { classLabel = "Loud"; classCss = "classification loud"; }
        dbDisplay = `${db} dB`;
      }

      card.innerHTML = `
        <div class="media-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
        <div class="media-meta">&lt;${m.tag}&gt;${m.metrics ? ` · ${m.metrics.sampleRate}Hz · ${m.metrics.channelCount}ch` : ""}</div>
        <div class="card-row">
          <div class="badges">
            <span class="badge ${stateClass}">${stateLabel}</span>
            ${classLabel ? `<span class="badge ${classCss}">${classLabel}</span>` : `<span class="badge classification">—</span>`}
            ${dbDisplay ? `<span class="badge classification" style="min-width:58px">${dbDisplay}</span>` : ""}
          </div>
          <button class="btn-play-pause">${btnLabel}</button>
        </div>
      `;

      // Click the card body to jump to the tab.
      card.addEventListener("click", (e) => {
        // Don't jump if they clicked the play/pause button.
        if (e.target.classList.contains("btn-play-pause")) return;
        port.postMessage({ type: "jump-to-tab", tabId });
      });

      // Play/pause button.
      card.querySelector(".btn-play-pause").addEventListener("click", (e) => {
        e.stopPropagation();
        port.postMessage({
          type: "toggle-media",
          tabId,
          src: m.src,
          action: m.paused ? "play" : "pause",
        });
      });

      section.appendChild(card);
    });

    listEl.appendChild(section);
  });
}

function countTabs(mediaList) {
  return new Set(mediaList.map((m) => m.tabId)).size;
}

// --- Toggle handler ---

stackToggle.addEventListener("change", () => {
  port.postMessage({ type: "toggle-audio-stack", enabled: stackToggle.checked });
});

overlayToggle.addEventListener("change", () => {
  port.postMessage({ type: "set-overlay-visible", visible: overlayToggle.checked });
});

const normalizeExpand = document.getElementById("normalize-expand");
normalizeExpand.addEventListener("click", () => {
  const visible = targetDbRow.style.display === "none";
  targetDbRow.style.display = visible ? "" : "none";
  normalizeExpand.innerHTML = visible ? "&#9650;" : "&#9660;";
});

normalizeToggle.addEventListener("change", () => {
  const enabled = normalizeToggle.checked;
  port.postMessage({ type: "set-setting-from-popup", key: "normalize", value: enabled });
});

targetDbSlider.addEventListener("input", () => {
  const val = parseInt(targetDbSlider.value, 10);
  targetDbValue.textContent = val;
  port.postMessage({ type: "set-setting-from-popup", key: "target-db", value: val });
});

// --- Listen for updates ---

port.onMessage.addListener((msg) => {
  if (msg.type === "all-media") {
    renderMedia(msg.media);
  }
  if (msg.type === "audio-stack") {
    renderStack(msg.stack, msg.enabled);
  }
  if (msg.type === "overlay-state") {
    overlayToggle.checked = msg.visible;
  }
  if (msg.type === "normalize-state") {
    normalizeToggle.checked = msg.enabled;
    targetDbSlider.value = msg.targetDb;
    targetDbValue.textContent = msg.targetDb;
  }
});
