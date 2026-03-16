# LxxsAudioLab

Real-time cross-tab media controller and web audio inspector — built as a Chrome Extension (Manifest V3).

## What It Does

LxxsAudioLab detects every `<audio>` and `<video>` element across your entire browser, shows you what's playing, and gives you control over all of it from one place — without leaving the page you're on.

Think of it as a **cross-tab media remote**.

## Features

### Implemented

- **Cross-Tab Media Detection** — Automatically detects all unmuted audio and video playing across every open tab. Shows the media name, source type, and play/pause state.

- **Smart Muted Media Filtering** — Muted media is excluded from the list entirely. This handles YouTube thumbnail previews, Twitter/X autoplay, Instagram reels, and any other muted autoplay. Media appears automatically when the user unmutes it, and disappears when muted again.

- **Audio Name Extraction** — Pulls the name of what's playing from multiple sources: the element's `title` attribute, `aria-label`, YouTube-specific headings, or the page title as a fallback.

- **Audio Focus Stack** — When you start playing audio in a new tab, the previous tab's audio automatically pauses. When the new audio stops, the previous one resumes. This nests infinitely — background music → Twitter video → Reddit clip → each one resumes in order when the one above it stops. Toggling the stack on with multiple tabs playing will keep only the most recent one and pause the rest. Disabled by default.

- **Remote Play/Pause** — Each media card has a play/pause button. Control any tab's audio directly from the overlay or popup without switching tabs. Works seamlessly with the audio focus stack.

- **Click-to-Jump** — Click any media card to instantly switch to that tab.

- **Persistent Overlay** — A semi-transparent overlay in the top-right corner of every page. Shows all media across all tabs with play/pause controls. Draggable, collapsible, and toggleable. Disabled by default — enable it from the popup.

- **Global Keyboard Shortcuts**
  - `Alt+Shift+P` — Play/pause the current audio from anywhere, no need to find the tab
  - `Alt+Shift+J` — Jump to the tab that's currently playing

- **Settings** — Accessible from the gear icon on the overlay or from toggles in the popup:
  - Toggle Audio Focus Stack on/off
  - Toggle Overlay visibility on/off

- **Popup** — A traditional toolbar popup as a fallback UI, with the same feature set as the overlay.

### Planned

- **Audio Classification** — Real-time label on each media element: Quiet (< -30 dBFS), Normal (-30 to -10 dBFS), or Loud (> -10 dBFS), computed from windowed RMS inside an AudioWorklet.

- **Real-Time Metrics** — Live display of sample rate, channel count, RMS level, peak level, and dBFS — computed inside an AudioWorklet running on the audio render thread.

- **Loudness Normalization** — Automatic gain adjustment to bring audio to a target loudness (e.g., -16 dBFS). Uses sliding window RMS, attack/release smoothing envelopes, and max gain caps to avoid artifacts. Will be configurable from the overlay settings.

- **Live dB Meter** — Visual meter showing current loudness in the overlay.

- **Gain Reduction Meter** — Shows how much the normalizer is adjusting gain in real time.

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `LxxsAudioLab` folder
5. The extension icon appears in your toolbar — click it to open the popup

## Overlay Controls

| Control           | Action                                  |
| ----------------- | --------------------------------------- |
| Drag header       | Move the overlay anywhere on the page   |
| Gear icon         | Open/close settings panel               |
| Arrow icon        | Collapse/expand the overlay body        |
| X icon            | Hide the overlay (re-enable from popup) |
| Click a card      | Jump to that tab                        |
| Play/Pause button | Control that tab's audio remotely       |

## Keyboard Shortcuts

| Shortcut      | Action                         |
| ------------- | ------------------------------ |
| `Alt+Shift+P` | Play/pause the current audio   |
| `Alt+Shift+J` | Jump to the tab that's playing |

Shortcuts can be customized at `chrome://extensions/shortcuts`.

## Project Structure

```
LxxsAudioLab/
├── manifest.json              # Extension config (Manifest V3)
├── background/
│   └── background.js          # Service worker — media tracking, audio stack, shortcuts
├── content/
│   └── content.js             # Injected into pages — detects media, handles commands
├── overlay/
│   ├── overlay.js             # Overlay UI logic — injected via content script
│   └── overlay.css            # Overlay styles — loaded into shadow DOM
├── page/
│   └── page-script.js         # Runs in page context (Phase 2: AudioContext hooking)
├── popup/
│   ├── popup.html             # Toolbar popup UI
│   └── popup.js               # Popup logic — media list, stack, click-to-jump
└── README.md
```

## Architecture

The extension has three isolated JavaScript worlds that communicate via Chrome's message-passing APIs:

1. **Content Script + Overlay** (`content/content.js`, `overlay/overlay.js`) — Injected into every page. Detects `<audio>` and `<video>` elements, renders the persistent overlay inside a Shadow DOM, and receives pause/resume commands from the background worker.

2. **Background Service Worker** (`background/background.js`) — The central hub. Aggregates media from all tabs, manages the audio focus stack, handles keyboard shortcuts, and broadcasts updates to all overlays and the popup.

3. **Popup** — Toolbar popup that connects to the background worker via a persistent port. Same controls as the overlay.

```
Content Script + Overlay (per tab)
    ↕ chrome.runtime messages
Background Service Worker
    ↕ persistent port connections
Popup (on-demand)
```
