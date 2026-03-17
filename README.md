# LxxsAudioLab

Real-time cross-tab media controller, web audio inspector, and loudness normalizer — built as a Chrome Extension (Manifest V3).

## What It Does

LxxsAudioLab detects every `<audio>` and `<video>` element across your entire browser, shows you what's playing, and gives you control over all of it from one place — without leaving the page you're on.

It also hooks into the Web Audio pipeline to compute real-time audio metrics (RMS, peak, dBFS) and apply automatic loudness normalization.

Think of it as a **cross-tab media remote + audio DevTools**.

## Features

- **Cross-Tab Media Detection** — Automatically detects all unmuted audio and video playing across every open tab. Shows the media name, source type, and play/pause state.

- **Off-DOM Audio Detection** — Catches audio played via `new Audio()` (WhatsApp voice messages, Slack, etc.) that never appears in the DOM.

- **Smart Muted Media Filtering** — Muted media is excluded entirely. Handles YouTube thumbnail previews, Twitter/X autoplay, Instagram reels. Media appears when unmuted, disappears when muted.

- **Audio Name Extraction** — Pulls the name from the element's `title`, `aria-label`, YouTube-specific headings, or the page title as a fallback.

- **Real-Time Audio Metrics** — Computes windowed RMS, instantaneous peak, and dBFS inside an AudioWorklet on the audio render thread. Displayed live on each media card.

- **Audio Classification** — Real-time label on each playing element: Silent (< -60 dBFS), Quiet (-60 to -30), Normal (-30 to -10), or Loud (> -10). Uses smoothed dBFS to prevent jitter.

- **Loudness Normalization** — Automatic gain adjustment to bring all audio to a target loudness (default -14 dBFS). Uses sliding window RMS, attack/release smoothing envelopes, max gain cap (4x), and hard clipping protection. Configurable target via slider. Global across all tabs.

- **Audio Focus Stack** — When you start playing audio in a new tab, the previous tab's audio automatically pauses. When the new audio stops, the previous one resumes. Nests infinitely. Toggling on with multiple tabs playing keeps only the most recent. Disabled by default.

- **Remote Play/Pause** — Each media card has a play/pause button. Control any tab's audio directly from the overlay or popup without switching tabs.

- **Click-to-Jump** — Click any media card to instantly switch to that tab.

- **Persistent Overlay** — A semi-transparent overlay in the bottom-right corner. Shows all media across all tabs with play/pause controls, classification, and dB levels. Draggable, collapsible, toggleable. Disabled by default.

- **Global Keyboard Shortcuts**
  - `Alt+Shift+P` — Play/pause the current audio from anywhere
  - `Alt+Shift+J` — Jump to the tab that's currently playing

- **Settings** — Accessible from the overlay gear icon or popup toggles:
  - Overlay visibility on/off
  - Normalize Loudness on/off (with advanced target dB slider)
  - Audio Focus Stack on/off

- **Popup** — Traditional toolbar popup as a fallback UI with the same feature set as the overlay.

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `LxxsAudioLab` folder
5. The extension icon appears in your toolbar — click it to open the popup

## Overlay Controls

| Control | Action |
|---|---|
| Drag header | Move the overlay anywhere on the page |
| Gear icon | Open/close settings panel |
| Arrow icon | Collapse/expand the overlay body |
| X icon | Hide the overlay (re-enable from popup) |
| Click a card | Jump to that tab |
| Play/Pause button | Control that tab's audio remotely |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+P` | Play/pause the current audio |
| `Alt+Shift+J` | Jump to the tab that's playing |

Shortcuts can be customized at `chrome://extensions/shortcuts`.

## Project Structure

```
LxxsAudioLab/
├── manifest.json                  # Extension config (Manifest V3)
├── background/
│   └── background.js              # Service worker — media tracking, audio stack, normalization, shortcuts
├── content/
│   └── content.js                 # Injected into pages — detects media, handles commands, bridges page script
├── overlay/
│   ├── overlay.js                 # Overlay UI — injected via content script, Shadow DOM isolated
│   └── overlay.css                # Overlay styles
├── page/
│   └── page-script.js             # Runs in page context — AudioContext hooking, off-DOM detection
├── worklet/
│   └── analyzer-processor.js      # AudioWorklet — RMS/peak/dBFS computation, loudness normalization
├── popup/
│   ├── popup.html                 # Toolbar popup UI
│   └── popup.js                   # Popup logic
└── README.md
```

## Architecture

The extension has three isolated JavaScript worlds communicating via Chrome's message-passing APIs:

1. **Content Script + Overlay** (`content/content.js`, `overlay/overlay.js`) — Injected into every page. Detects media elements, renders the overlay inside Shadow DOM, and bridges communication between the page script and background worker.

2. **Page Script** (`page/page-script.js`) — Runs in the page's JS context. Hooks into media elements via `createMediaElementSource()`, builds the audio processing chain, intercepts off-DOM `new Audio()` playback, and forwards normalization commands to the AudioWorklet.

3. **AudioWorklet** (`worklet/analyzer-processor.js`) — Runs on the audio render thread. Computes RMS, peak, and dBFS from raw PCM samples. Applies loudness normalization with attack/release envelope smoothing.

4. **Background Service Worker** (`background/background.js`) — The central hub. Aggregates media from all tabs, manages the audio focus stack, tracks normalization state, handles keyboard shortcuts, and broadcasts updates.

5. **Popup** — Toolbar popup connecting via persistent port. Same controls as the overlay.

```
Page Script (AudioContext + Worklet)
    ↕ window.postMessage
Content Script + Overlay
    ↕ chrome.runtime messages
Background Service Worker
    ↕ persistent port connections
Popup
```

## Audio Processing Chain

```
MediaElement (<video> / <audio>)
    ↓
createMediaElementSource()    ← captures raw PCM stream
    ↓
GainNode (1.0)                ← reserved for future use
    ↓
AudioWorkletNode              ← computes metrics + applies normalization
    ↓
AudioContext.destination       ← back to speakers
```
