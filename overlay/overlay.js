// Overlay UI — injected into every page, renders inside a Shadow DOM.

(function () {
  if (document.getElementById("lxxs-audio-lab-overlay")) return;

  let overlayAlive = true;
  function safeSend(msg, callback) {
    if (!overlayAlive) return;
    try {
      chrome.runtime.sendMessage(msg, callback);
    } catch {
      overlayAlive = false;
      clearInterval(pollInterval);
    }
  }

  // --- Create host element + shadow DOM ---
  const host = document.createElement("div");
  host.id = "lxxs-audio-lab-overlay";
  const shadow = host.attachShadow({ mode: "closed" });

  // Load styles.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay/overlay.css");
  shadow.appendChild(link);

  // --- Build DOM ---
  const container = document.createElement("div");
  container.className = "overlay-container";

  container.innerHTML = `
    <div class="overlay-header">
      <span class="overlay-title">LxxsAudioLab</span>
      <div class="overlay-controls">
        <button class="overlay-btn" data-action="settings" title="Settings">&#9881;</button>
        <button class="overlay-btn" data-action="collapse" title="Collapse">&#9660;</button>
        <button class="overlay-btn" data-action="close" title="Hide overlay">&#10005;</button>
      </div>
    </div>
    <div class="overlay-body"></div>
    <div class="o-settings">
      <div class="o-setting-row">
        <span class="o-setting-label">Show Overlay</span>
        <label class="o-toggle">
          <input type="checkbox" data-setting="show-overlay" />
          <span class="o-toggle-track"></span>
        </label>
      </div>
      <div class="o-setting-row">
        <span class="o-setting-label">Audio Focus Stack</span>
        <label class="o-toggle">
          <input type="checkbox" data-setting="audio-stack" />
          <span class="o-toggle-track"></span>
        </label>
      </div>
      <div class="o-setting-row">
        <span class="o-setting-label">Normalize Loudness</span>
        <span class="o-setting-controls">
          <button class="o-expand-btn" data-expand="target-db" title="Advanced" style="background:none;border:none;color:#666;font-size:10px;cursor:pointer;padding:2px 4px">&#9660;</button>
          <label class="o-toggle">
            <input type="checkbox" data-setting="normalize" />
            <span class="o-toggle-track"></span>
          </label>
        </span>
      </div>
      <div class="o-setting-row" data-row="target-db" style="display:none">
        <span class="o-setting-label">Target: <span data-target-value>-14</span> dB</span>
        <input type="range" data-setting="target-db" min="-30" max="-6" value="-14" style="width:80px;accent-color:#4ec94e" />
      </div>      
    </div>
  `;

  shadow.appendChild(container);

  const body = container.querySelector(".overlay-body");
  const settingsPanel = container.querySelector(".o-settings");
  const collapseBtn = container.querySelector('[data-action="collapse"]');
  let collapsed = false;

  // --- Controls ---
  container
    .querySelector('[data-action="settings"]')
    .addEventListener("click", () => {
      settingsPanel.classList.toggle("open");
    });

  collapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    body.classList.toggle("overlay-body-hidden", collapsed);
    settingsPanel.classList.remove("open");
    collapseBtn.innerHTML = collapsed ? "&#9650;" : "&#9660;";
    collapseBtn.title = collapsed ? "Expand" : "Collapse";
  });

  container
    .querySelector('[data-action="close"]')
    .addEventListener("click", () => {
      host.style.display = "none";
      safeSend({ type: "set-overlay-visible", visible: false });
    });

  // --- Settings toggles ---
  const stackToggle = container.querySelector('[data-setting="audio-stack"]');
  const overlayToggle = container.querySelector(
    '[data-setting="show-overlay"]',
  );
  const normalizeToggle = container.querySelector('[data-setting="normalize"]');
  const targetDbSlider = container.querySelector('[data-setting="target-db"]');
  const targetDbRow = container.querySelector('[data-row="target-db"]');
  const targetDbValue = container.querySelector('[data-target-value]');

  stackToggle.addEventListener("change", () => {
    safeSend({
      type: "set-setting",
      key: "audio-stack",
      value: stackToggle.checked,
    });
  });

  overlayToggle.addEventListener("change", () => {
    const visible = overlayToggle.checked;
    host.style.display = visible ? "" : "none";
    safeSend({ type: "set-overlay-visible", visible });
  });

  const expandBtn = container.querySelector('[data-expand="target-db"]');
  expandBtn.addEventListener("click", () => {
    const visible = targetDbRow.style.display === "none";
    targetDbRow.style.display = visible ? "" : "none";
    expandBtn.innerHTML = visible ? "&#9650;" : "&#9660;";
  });

  normalizeToggle.addEventListener("change", () => {
    const enabled = normalizeToggle.checked;
    safeSend({
      type: "set-setting",
      key: "normalize",
      value: enabled,
    });
  });

  targetDbSlider.addEventListener("input", () => {
    const val = parseInt(targetDbSlider.value, 10);
    targetDbValue.textContent = val;
    safeSend({
      type: "set-setting",
      key: "target-db",
      value: val,
    });
  });

  // --- Dragging ---
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const header = container.querySelector(".overlay-header");
  header.addEventListener("mousedown", (e) => {
    if (e.target.closest(".overlay-btn")) return;
    isDragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    header.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    host.style.left = x + "px";
    host.style.top = y + "px";
    host.style.right = "auto";
    host.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = "grab";
    }
  });

  // --- Rendering ---
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

  function render(mediaList) {
    body.innerHTML = "";

    if (!mediaList || mediaList.length === 0) {
      body.innerHTML = `<div class="o-empty">No media detected</div>`;
      return;
    }

    mediaList.forEach((m) => {
      const card = document.createElement("div");
      card.className = "o-card";

      const stateClass = m.paused ? "paused" : "playing";
      const stateLabel = m.paused ? "Paused" : "Playing";
      const btnLabel = m.paused ? "Play" : "Pause";
      const domain = getDomain(m.tabUrl || "");

      // Audio classification from metrics.
      let classLabel = "";
      let classColor = "";
      let dbDisplay = "";
      if (m.metrics && !m.paused) {
        const db = m.metrics.smoothedDb ?? m.metrics.rmsDb;
        if (db <= -60) {
          classLabel = "Silent";
          classColor = "#666";
        } else if (db <= -30) {
          classLabel = "Quiet";
          classColor = "#5b9bd5";
        } else if (db <= -10) {
          classLabel = "Normal";
          classColor = "#4ec94e";
        } else {
          classLabel = "Loud";
          classColor = "#e05050";
        }
        dbDisplay = `${db} dB`;
      }

      card.innerHTML = `
        <div class="o-card-top">
          <span class="o-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
          <button class="o-btn">${btnLabel}</button>
        </div>
        <div class="o-meta">
          <span class="o-badge ${stateClass}">${stateLabel}</span>
          ${classLabel ? `<span class="o-badge" style="background:${classColor}22;color:${classColor}">${classLabel}</span>` : ""}
          ${dbDisplay ? `<span class="o-tab-label" style="min-width:45px">${dbDisplay}</span>` : ""}
          <span class="o-tab-label">${escapeHtml(domain || m.tabTitle || "")}</span>
        </div>
      `;

      // Click card → jump to tab.
      card.addEventListener("click", (e) => {
        if (e.target.closest(".o-btn")) return;
        safeSend({ type: "jump-to-tab-from-content", tabId: m.tabId });
      });

      // Play/pause button.
      card.querySelector(".o-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        safeSend({
          type: "toggle-media-from-content",
          tabId: m.tabId,
          src: m.src,
          action: m.paused ? "play" : "pause",
        });
      });

      body.appendChild(card);
    });
  }

  // --- Communication with background ---
  function requestUpdate() {
    safeSend({ type: "get-all-media-from-content" }, (response) => {
      if (!response) return;
      if (response.media) {
        render(response.media);
      }
      if (typeof response.stackEnabled === "boolean") {
        stackToggle.checked = response.stackEnabled;
      }
      if (typeof response.overlayVisible === "boolean") {
        host.style.display = response.overlayVisible ? "" : "none";
        overlayToggle.checked = response.overlayVisible;
      }
      if (typeof response.normalizeEnabled === "boolean") {
        normalizeToggle.checked = response.normalizeEnabled;
      }
      if (typeof response.targetDb === "number") {
        targetDbSlider.value = response.targetDb;
        targetDbValue.textContent = response.targetDb;
      }
    });
  }

  // Listen for pushes from background.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "overlay-update" && msg.media) {
      render(msg.media);
    }
    if (msg.type === "overlay-settings") {
      if (typeof msg.stackEnabled === "boolean") {
        stackToggle.checked = msg.stackEnabled;
      }
    }
    if (msg.type === "set-overlay-display") {
      host.style.display = msg.visible ? "" : "none";
      overlayToggle.checked = msg.visible;
    }
    if (msg.type === "normalize-state") {
      normalizeToggle.checked = msg.enabled;
      targetDbSlider.value = msg.targetDb;
      targetDbValue.textContent = msg.targetDb;
    }
  });

  // Initial data fetch.
  requestUpdate();

  // Poll as a fallback (the background also pushes updates).
  const pollInterval = setInterval(requestUpdate, 2000);

  // --- Mount (hidden by default) ---
  host.style.display = "none";
  document.body.appendChild(host);
})();
