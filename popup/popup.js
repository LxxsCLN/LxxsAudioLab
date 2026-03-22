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

// --- Media list rendering (with in-place patching) ---

// Track cards by key for in-place updates.
const cardMap = new Map();
let lastMediaOrder = "";

function getClassification(m) {
  let classLabel = "", classCss = "classification", dbDisplay = "";
  if (m.metrics && !m.paused) {
    const db = m.metrics.smoothedDb ?? m.metrics.rmsDb;
    if (db <= -60) { classLabel = "Silent"; classCss = "classification silent"; }
    else if (db <= -30) { classLabel = "Quiet"; classCss = "classification quiet"; }
    else if (db <= -10) { classLabel = "Normal"; classCss = "classification normal"; }
    else { classLabel = "Loud"; classCss = "classification loud"; }
    dbDisplay = `${db} dB`;
  }
  return { classLabel, classCss, dbDisplay };
}

function patchCard(card, m) {
  const stateBadge = card.querySelector('[data-role="state"]');
  const classBadge = card.querySelector('[data-role="class"]');
  const dbBadge = card.querySelector('[data-role="db"]');
  const btn = card.querySelector(".btn-play-pause");

  const stateClass = m.paused ? "paused" : "playing";
  stateBadge.className = `badge ${stateClass}`;
  stateBadge.textContent = m.paused ? "Paused" : "Playing";

  const { classLabel, classCss, dbDisplay } = getClassification(m);
  classBadge.className = `badge ${classCss}`;
  classBadge.textContent = classLabel || "\u2014";

  dbBadge.textContent = dbDisplay;
  dbBadge.style.display = dbDisplay ? "" : "none";

  btn.textContent = m.paused ? "Play" : "Pause";
  card.dataset.paused = m.paused ? "1" : "0";
}

function createCard(m, tabId) {
  const card = document.createElement("div");
  card.className = "media-card";
  card.title = "Click to jump to this tab";
  card.dataset.paused = m.paused ? "1" : "0";

  const stateClass = m.paused ? "paused" : "playing";
  const stateLabel = m.paused ? "Paused" : "Playing";
  const btnLabel = m.paused ? "Play" : "Pause";
  const { classLabel, classCss, dbDisplay } = getClassification(m);

  card.innerHTML = `
    <div class="media-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
    <div class="media-meta">&lt;${m.tag}&gt;${m.metrics ? ` · ${m.metrics.sampleRate}Hz · ${m.metrics.channelCount}ch` : ""}</div>
    <div class="card-row">
      <div class="badges">
        <span class="badge ${stateClass}" data-role="state">${stateLabel}</span>
        <span class="badge ${classCss}" data-role="class">${classLabel || "\u2014"}</span>
        <span class="badge classification" data-role="db" style="min-width:58px;${dbDisplay ? "" : "display:none"}">${dbDisplay}</span>
      </div>
      <button class="btn-play-pause">${btnLabel}</button>
    </div>
  `;

  // Click the card body to jump to the tab.
  card.addEventListener("click", (e) => {
    if (e.target.classList.contains("btn-play-pause")) return;
    port.postMessage({ type: "jump-to-tab", tabId });
  });

  // Play/pause button — reads current state from data attribute.
  card.querySelector(".btn-play-pause").addEventListener("click", (e) => {
    e.stopPropagation();
    const isPaused = card.dataset.paused === "1";
    port.postMessage({
      type: "toggle-media",
      tabId,
      src: m.src,
      action: isPaused ? "play" : "pause",
    });
  });

  return card;
}

function renderMedia(mediaList) {
  if (!mediaList || mediaList.length === 0) {
    cardMap.clear();
    lastMediaOrder = "";
    statusEl.textContent = "No media";
    listEl.innerHTML = `
      <div class="empty-state">
        No audio or video detected.<br/>
        Play something to get started.
      </div>
    `;
    return;
  }

  statusEl.textContent = `${mediaList.length} media \u00B7 ${countTabs(mediaList)} tab${countTabs(mediaList) !== 1 ? "s" : ""}`;

  const newOrder = mediaList.map((m) => `${m.tabId}:${m.src}`).join("|");

  // If the same cards exist in the same order, just patch dynamic parts in-place.
  if (newOrder === lastMediaOrder) {
    mediaList.forEach((m) => {
      const card = cardMap.get(`${m.tabId}:${m.src}`);
      if (card) patchCard(card, m);
    });
    return;
  }

  // Structure changed — full rebuild.
  lastMediaOrder = newOrder;
  cardMap.clear();
  listEl.innerHTML = "";

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
      const card = createCard(m, tabId);
      cardMap.set(`${tabId}:${m.src}`, card);
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
let targetDbVisible = false;
normalizeExpand.addEventListener("click", () => {
  targetDbVisible = !targetDbVisible;
  targetDbRow.style.display = targetDbVisible ? "block" : "none";
  normalizeExpand.textContent = targetDbVisible ? "\u25B4" : "\u25BE";
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
