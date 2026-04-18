# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**横瀬町 罠猟ノート** — A mobile-first trap hunting field note app for Yokose Town, Saitama Prefecture. It records trap locations (GPS), type, status, trail camera sightings, and displays them on a GSI (国土地理院) map with offline tile caching.

## The actual app

**`trap-notes.html`** is the real, deployed application. It is a self-contained single HTML file using CDN-loaded React 18 (via Babel standalone), Leaflet 1.9.4, and Tailwind. This is what gets served and used.

The `src/` directory and Vite project are a scaffolding remnant from the `web-artifacts-builder` skill — the Parcel bundler could not handle Leaflet's CSS imports, so the build approach was abandoned. Do not attempt to build `src/App.tsx` with Parcel or Vite; it will fail.

## Development workflow

```bash
# Serve locally (auto-installs serve if needed)
npx serve .
# Then open: http://localhost:3000/trap-notes.html

# Or from parent directory
cd C:/Users/cec37/claude-projects/yokose-trap-notes
npx serve .
```

There is no build step for `trap-notes.html`. Edit the file directly and reload the browser.

## Architecture of trap-notes.html

The entire app is one `<script type="text/babel" data-presets="react">` block. Babel transpiles JSX in the browser at runtime.

**Data model** (persisted to `localStorage` key `yokose-v4`):
```
Trap { id, trapId (A-001), type (kukuri/hako/other), status (稼働中/要確認/撤去済み),
       installedAt, lat, lng, notes, sightings: Sighting[], createdAt, updatedAt }
Sighting { id, timestamp, animal (shika/tanuki/araiguma/anaguma/other), notes }
```

**Key constants:**
- `CENTER = [35.9722871, 139.165769]` — カリラボ, ZOOM0 = 15
- `TILE_CACHE = 'gsi-v2'` — Cache API bucket for offline GSI tiles
- `SK = 'yokose-v4'` — localStorage key

**Offline tile caching:** `OfflineTiles` extends `L.TileLayer`, overriding `createTile()` to use the Cache API (cache-first → network → fallback SVG). `cacheViewport()` pre-fetches tiles for the current map bounds. This is the Service Worker substitute for single-file deployment.

**Map pin rendering:** `makePin(trap, selected)` returns a `L.DivIcon` with emoji + status color ring. `makePopup(trap)` returns HTML string for Leaflet popups.

**Mobile layout:**
- Bottom nav (地図/一覧 tabs) + wide FAB-style add button fixed above nav
- Map tab: Leaflet map always in DOM (never conditionally rendered) — `invalidateSize()` called on tab switch
- List tab: overlays the map with `position:absolute`
- Detail view: slides in from right over everything (`z-index:100`)
- Forms: bottom sheet on mobile, centered modal on desktop (`@media min-width:768px`)

**Auto-ID:** `nextTrapId(traps)` reads existing `A-NNN` IDs, finds max N, returns `A-(N+1)` zero-padded to 3 digits.

**GPS pick flow:** "地図で指定" closes the form sheet → sets `picking=true` (stored in both React state and `pickRef` for use inside the Leaflet click handler) → map click handler fires → updates draft coords → reopens form.

## Deployment

Pushed to GitHub: `https://github.com/adapyon/yokoze-trap-notes`

The repo contains both `trap-notes.html` (the app) and the unused Vite scaffold in `src/` plus the `yokose-redesign/` subdirectory (another scaffold copy). Only `trap-notes.html` matters for the running application.
