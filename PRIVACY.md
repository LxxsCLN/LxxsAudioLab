# Privacy Policy — AudioLab

**Last updated:** March 2026

## Overview

AudioLab is a browser extension that detects and controls audio/video playback across your browser tabs. It does not collect, store, transmit, or share any user data.

## What the extension accesses

AudioLab accesses the following information **locally on your device only**:

- **Media element metadata** — Detects `<audio>` and `<video>` elements on web pages to display their name, playback state, and source type. This information is used only to render the extension's UI and is never stored or transmitted.
- **Tab titles and URLs** — Used to display which tab media is playing in. This information stays in your browser's memory and is discarded when the tab is closed.
- **Audio stream data** — The extension hooks into the Web Audio API to compute real-time loudness metrics (RMS, peak, dBFS) and apply optional loudness normalization. Audio data is processed entirely on your device in real time and is never recorded, stored, or transmitted.

## What the extension does NOT do

- Does not collect personal information
- Does not track browsing history or behavior
- Does not transmit any data to external servers
- Does not use cookies or local storage for tracking (local storage is used solely to persist your settings preferences)
- Does not inject ads
- Does not modify web page content (other than the optional overlay UI)

## Permissions explained

- **`tabs`** — Required to read tab titles and URLs for the cross-tab media list.
- **`activeTab`** — Required to interact with the currently active tab.
- **`scripting`** — Required to inject the content script that detects media elements.
- **`storage`** — Required to persist user settings (overlay visibility, audio focus stack, normalization preferences) across browser sessions. Data is stored locally via `chrome.storage.local` and is never transmitted.
- **`<all_urls>` (host permission via content scripts)** — Required because media can play on any website. The extension needs to run on all pages to detect audio and video elements.

## Data retention

AudioLab stores only your settings preferences (overlay visibility, audio focus stack, loudness normalization, target dB) locally on your device via `chrome.storage.local`. All other information exists only in browser memory during the current session and is discarded when tabs are closed or the browser is restarted.

## Contact

For questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/LxxsCLN/LxxsAudioLab).
