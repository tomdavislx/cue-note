# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CueNote is an Electron + React + TypeScript desktop app (built with Electron Forge and Webpack) for remotely viewing and editing cue notes on ETC Eos lighting consoles. Console communication (OSC over TCP) is handled by the external `eos-console` package; this repo only consumes its `EosConsole` class.

## Commands

Yarn is the package manager (`yarn.lock`). If `yarn` isn't on the PATH, use `corepack yarn`.

- `yarn start` — run the app in development (Forge + Webpack dev server)
- `yarn lint` — ESLint over `.ts`/`.tsx` (includes `eslint-plugin-tailwindcss` class checks)
- `yarn make` / `yarn package` — build distributables (DMG on macOS, Squirrel on Windows)
- `yarn publish` — publish a draft GitHub release; CI does this on pushing a `X.Y.Z` tag (`.github/workflows/release.yml`)

There is no test suite. Type checking runs via `fork-ts-checker-webpack-plugin` during `yarn start`/`make`; TypeScript is pinned to ~4.5.

`macos-alias` (optional dep of the DMG maker) fails to compile on Node 24; the failure is harmless for development.

## Architecture

Three Electron layers, connected by a hand-maintained IPC surface:

- **Main process (`src/index.ts`)** — owns the single `EosConsole` instance (module-level `eos`). `ipcMain.handle`/`on` handlers named `console:*` wrap console calls, and `eos.on(...)` listeners forward console events to the renderer with `webContents.send`. It also updates the window title (show name) and taskbar progress bar (cue sync).
- **Preload (`src/preload.ts`)** — defines `ContextBridgeApi` and exposes it as `window.api` via `contextBridge`. `src/types/window.d.ts` types `window.api` from that. `on*` subscriptions return an unsubscribe function.
- **Renderer (`src/renderer.tsx`, `src/App.tsx`, `src/components/`)** — React UI with Tailwind. `App.tsx` holds connection state, the cue list and active cue, and is the only place subscribing to console events; `CueNoteMain` and children receive props.

Adding a console feature means touching all three: handler in `index.ts`, method in `ContextBridgeApi` plus its `exposedApi` implementation in `preload.ts`, then a call from the renderer. IPC channel names and payload shapes aren't type-checked across the boundary, so keep the strings and the argument/destructuring shapes in sync by hand. Some events send wrapped payloads (e.g. `console:active-cue` sends `{ cue }`, `console:show-name` sends `{ showName }`) and the preload unwraps them.

Console discovery uses `EtcDiscovery` from `eos-console` (main process, `discovery:start`/`discovery:stop`/`discovery:devices-changed`); `ConsoleDiscovery` starts it on mount and stops it on unmount, with a toggle to `ManualConnectionForm`. Connection errors are not sent as events: `console:connect` rethrows, and `ConsoleConnectionCard` catches the rejected `connectConsole()` promise and shows a `react-hot-toast` toast.

Flow on connect: `console:connect` → main emits `console:connection-state` → `App` calls `getCues()` (progress reported via `console:get-cues-progress`) → live updates arrive as `console:cue-change`, after which `App` refetches each changed cue with `getCue` and inserts, replaces or deletes it in state.

Things to know:
- Only cue list 1 is supported; it is hardcoded in several places (`index.ts`, `App.tsx`, `CueNoteMain.tsx`).
- Notes are written back to the console by sending `/eos/set/cue/<list>/<cue>/notes` over OSC (`console:update-cue-notes`).
- Quick note button text is persisted locally via `src/hooks/use-local-storage.ts`, not on the console.
- Ambient typings for untyped deps live in `src/types/` (`osc-min`, `slip`).
- Keyboard shortcuts (Ctrl/Cmd+D clears the current cue's note, Ctrl/Cmd+E focuses the note input) are registered in `CueNoteMain.tsx` with `react-hotkeys-hook`.
- Window uses a hidden title bar with a custom `TitleBar` component; the main process opens DevTools unconditionally in `createWindow`.
