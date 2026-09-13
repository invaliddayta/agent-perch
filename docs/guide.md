# The Perch Manual

[Overview](../README.md) / [First run](../START_HERE.md) / **Manual** / [Agent setup](backends.md) / [Verification](verification.md)

Perch connects a browser to tmux on a Linux host. All four agents run as native CLIs. tmux owns the sessions; agents own conversations, approvals, and compaction. Perch is the window, not the foreman.

**Jump to:** [Setup](#quick-start) / [Daily use](#daily-use) / [Speech](#private-voice) / [Configuration](#configuration) / [Operations](#operations)

## Requirements

- Linux, Bun 1.3.10+ with native PTY support, and tmux 3.3+. The service installer also needs systemd user services.
- Install and authenticate whichever agent CLIs you want to launch. Existing tmux sessions need no additional agent installation.
- A modern browser with JavaScript and WebSockets. Clipboard, microphone, and installation features need HTTPS or localhost and browser permission.
- Run as the account that owns your sessions, not root. Native Windows/macOS servers have not been verified.

## Quick Start

Keep the checkout in a permanent directory owned by that account:

```sh
bun install --frozen-lockfile
bun run build
bun run install:service --dry-run
bun run install:service
```

Open **http://localhost:4310/**. The installer writes one user service, `agent-watch.service`, and creates a private `.env` if missing. The old service name is retained for existing installations. No OpenCode API server or shared password is needed by Perch.

An existing `.env` is preserved. Dry run writes nothing. Installation enables and starts the web service but does not restart it if already running. Stop a foreground Perch process before starting a service on the same port. Use [.env.example](../.env.example) as a reference; values are literal, not shell expressions.

### Private Remote Access

**Anyone who can reach Perch can control the host account.** There is no app login. Read [Security](../SECURITY.md) before opening access to another device.

For Tailscale, authenticate both devices and inspect `tailscale serve status` before taking over an existing route. With Perch's default port:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4310
```

Set `PUBLIC_ORIGIN` in `.env` to the exact HTTPS origin reported, then restart only `agent-watch.service`. If you change `PORT`, change the Serve target too.

Use **Serve, never Funnel**. Restrict your tailnet policy to trusted users/devices. The installer does not configure network policy or firewall rules. Another private/authenticated proxy is fine. Terminate TLS and authenticate **every** route at the proxy, including `/terminal` WebSocket handshakes; proxy to plain internal HTTP (`http://127.0.0.1:4310`). Perch does not implement TLS or login. Preserve the browser's `Origin`, forward the public `Host`, and support HTTP/1.1 `Upgrade` / `Connection` WebSocket forwarding with suitable idle timeouts. Set `PUBLIC_ORIGIN` to the exact external HTTPS origin. Preserve CSP and COOP/COEP response headers. Do not strip or spoof Origin to bypass rejection.

`HOST` changes only the listener (default `127.0.0.1`); `PORT` defaults to `4310`. A non-loopback listener is appropriate only when a separately firewalled internal proxy must reach it. It must never allow clients to bypass proxy authentication. Setting `HOST=0.0.0.0` does not authorize any additional browser origins. Prefer loopback on a single host; no deployment or firewall changes are made by Perch.

### Browser Installation

Use a normal tab, Chromium's install menu, or **Safari > Share > Add to Home Screen**. The host must still be reachable. Perch does not cache an offline app shell. An updated compatibility worker removes old shell caches without touching downloaded speech models. Physical installation and suspend/resume still need device testing; see [verification](verification.md).

### Without systemd

After installing dependencies and building, run `bun run start` from the checkout. Bun loads `.env` if present. All backends work without a separate OpenCode API server.

### Existing Installations

This terminal-first implementation removes API/database-derived status, one-click compact/continue, and operation journals. New launches now have native event indicators, but all approval and conversation controls remain in the agent's TUI. Check any in-flight legacy operation before upgrading; nothing is replayed or completed by the new server.

Existing tmux sessions still attach, including OpenCode sessions attached to an independently running API server. **Do not stop that server while those agents need it.** The installer never stops, replaces, or restarts `agent-watch-opencode.service`. The old `--terminal-only` flag is accepted but unnecessary.

Old `OPENCODE_URL`, `OPENCODE_DB_PATH`, and `HOST_LABEL` settings are unused by Perch. Existing session/operation JSON files are left untouched and ignored. `.state` holds private image uploads and the generated DSH launch patch, not conversation histories. Back up `.env` and `.state` privately before upgrading.

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
systemctl --user restart agent-watch.service
```

If service templates changed, inspect the installer dry run before applying them. New OpenCode sessions launch directly; existing agents and their configuration are not migrated.

## Daily Use

**New session** takes an absolute, home-relative (`~/...`), or relative path. Relative paths use `PROJECTS_ROOT`, which defaults to your home directory. Check **Create directory if it doesn't exist** to allow creation. A blank name is derived from the directory, with a suffix if needed. There is no `git init`.

The manager and switcher use the same searchable session list. Pin a session from its terminal header. **No status** means no native signal is available; it does not mean the agent is idle. **Exited** means all retained panes are dead. Read the TUI for the details and approval controls.

The **red X** on the right opens a matching confirmation dialog naming the session. **Cancel**, Escape, or closing the dialog leaves it running. **Kill session** ends that tmux session and its Perch viewers; unsaved work may be lost. Other sessions remain untouched. Windows explicitly linked to other user-owned tmux sessions survive, as do processes that independently daemonized. This is termination, not an undoable close-tab action.

Tap the terminal on a phone to open the keyboard. The touch strip adds Ctrl, Alt, Esc, Tab, arrows, and Enter. Ctrl and Alt latch for the next key. On desktops with a fine pointer, only the Esc button stays visible.

The UI uses self-hosted Proggy Clean at its whole-pixel 7px character width (16 CSS pixels). Terminal text uses a separate adjustable font. Phone controls have larger touch targets; swipe the key strip horizontally if the last keys do not fit. Text-entry fields retain a readable 16px system font on phones.

Perch doesn't detach your other clients. **Settings > Fit the terminal to this screen** is on by default; turn it off when another attached client's dimensions should win. Swipes scroll TUI/history using mouse routing scoped to this viewer. Search history, copy a selection, or scroll to the bottom from Settings.

Closing a tab or losing the network leaves the agent running. Reconnect creates a fresh viewer and never replays keystrokes. A host reboot or an exited agent is different: Perch does not restart the work. Pins persist in local browser storage; undelivered speech stays only in page memory and is lost on reload.

### Agent Attention

New sessions launched from Perch have native event observation. **Turn finished** means a successfully completed root turn was observed. **Needs attention** can mean a question, approval, or a Codex turn-completion notification; inspect the TUI before deciding what to do. **Agent error** is available when the backend emits the corresponding event. No event changes prompts, submits input, grants permissions, or resumes work automatically.

Unread events appear as a dot in the session list, an in-app banner, and a session count in the tab title and switcher button. **Open terminal** opens the relevant session/window; **Mark seen** acknowledges the displayed event. Switching sessions does not silently dismiss it. Acknowledgments persist locally and synchronize between tabs on the same browser origin, not between devices.

Only the latest unread event per pane is retained. It remains visible even if another turn starts before the next poll, so the badge describes an event to check, not a guarantee that the terminal is still waiting. State and event IDs live in tmux pane options, guarded by the launch identity and pane PID; no prompts or tool arguments are stored. DSH's generated patch is launch configuration, not a session log.

Existing agents are not injected into or restarted. Relaunch only when you choose to get native status. **No status** also applies before the first signal or if plugins/notifications are unavailable. One server-owned loop reconciles Codex observers at startup and every 3.5 seconds; new launches wait for their observer before proceeding. Session-list requests do not manage observers. A failed observer is retried even with no browser open. Events emitted during server downtime or reattachment can still be missed. OpenCode/DSH adapters keep reporting into tmux while the web service is down. This is not push notification delivery: the page must be running and able to poll the host to display updates.

See [backend adapters](backends.md) for the exact launch overlays. The installer does not modify agent configuration or install an extra agent server.

### Laptop Fullscreen

**Ctrl+Alt+S** (**Control+Option+S** on Mac) opens the switcher. Type to filter and Enter to select the first match; arrow keys and Home/End navigate session buttons. Escape closes Perch dialogs without reaching the agent. With a terminal selected, plain Escape reaches it even after clicking a toolbar button. Text fields and IME composition keep their own Escape handling. Separate presses remain separate inputs, including OpenCode's double Escape; holding the key does not spam it.

The terminal fills the page. **Toggle fullscreen** optionally hides browser bars and requests keyboard capture. Allow that browser permission to send Escape to the terminal in fullscreen. If capture is unsupported or denied, Perch stays page-sized or exits fullscreen and explains why. This applies to touch devices too, since they can have hardware keyboards.

Use Perch's button rather than the browser's native F11/menu fullscreen: web code cannot reliably capture Escape there or override OS-reserved shortcuts. Use the same button or the browser's emergency escape gesture to leave app fullscreen. The visible **Esc** button works without keyboard capture; **Ctrl+[** with terminal focus is another way to send the Escape byte. Ctrl/Cmd+V remains browser paste. Terminal keyboard handling is shared by OpenCode, Codex, DeepSeek, and other programs running in the pane.

### Clipboard Text

TUIs emitting supported OSC 52 writes can copy to the viewing device. A focused page with recent input attempts this automatically; if refused, tap **Copy to clipboard**. Ordinary paste stays terminal input.

The passive tmux control client does not change global clipboard settings or replace `pipe-pane` hooks. It follows native pane/window notifications, not a one-second pane poll. Only the displayed pane forwards text; writes are limited to 128 KiB and clipboard-read requests are ignored. Rapid pane/window round trips invalidate old delivery targets. Losing this observer disconnects the viewer so it can reconnect with fresh metadata; it does not kill the agent.

### Clipboard Images

Ctrl/Cmd+V uploads an image to a private host file and pastes a file reference into the active OpenCode or Pi prompt, without pressing Enter. Review before sending. Pi receives a quoted host path, not image bytes; it must read the file using its native tools. [Pi semantics](backends.md#pi).

Programmatic paste never appends Enter. The terminal protocol retains `submit: false` for already-open clients and rollback; `submit: true` is rejected before writing input. Ordinary terminal keystrokes remain separate from guarded paste.

Each image is limited to 10 MiB, with a 100 MiB total storage limit. Files live under `STATE_DIR/images`, not the web directory. Files older than 24 hours are removed on a later upload, not a scheduled expiry job. OpenCode may retain submitted attachments. Switching panes during upload prevents paste into the wrong terminal.

## Private Voice

Moonshine v2 Medium English (245M parameters, 8-bit weights with a floating-point frontend) runs in a dedicated **browser worker on the viewing device**. The host serves model files; it does not receive recorded audio. This replaces the previous multilingual Whisper Tiny model with an accuracy-first English model.

```sh
bun run voice:prepare
bun run build
```

Preparation fetches Moonshine's `medium-streaming-en/quantized_26_07_30` files, matching the catalog in pinned `@moonshine-ai/moonshine-wasm` **0.1.5**. File sizes are verified before publishing the readiness marker. The runtime and license are copied to a versioned `/speech/` directory. The first browser download is about **304 MiB**, with model caching by versioned URL. There is no external model/CDN fetch during inference or cloud transcription fallback. Rerun preparation and rebuild when upgrading from Whisper; the old readiness marker does not enable the new model.

The worker uses multithreaded WASM on the CPU, with no GPU or smaller-model fallback. Transcription is always English, regardless of browser language. Threaded WASM requires a secure context (HTTPS or localhost) and cross-origin isolation. The app and dev server send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; preserve these headers through reverse proxies. A missing-isolation error requires a page reload after fixing the headers.

Audio is decoded, downmixed to mono, resampled to 16 kHz, and transcribed locally. Recordings stop at 60 seconds. Recording and model loading can overlap; audio waits in memory if needed. Cancel discards it and releases the microphone.

Speech initially loads on demand. **Settings > Prepare speech** warms it without opening the microphone. First preparation or dictation enables **Prepare speech on startup**, remembered in this browser. On future visits, preparation starts in the background once the host reports that speech assets are available; it never requests microphone access. Turn off that setting to keep future loading manual, even when you dictate. Turning it off does not unload the current model. A failed background load can be retried with **Prepare speech**, not an automatic retry loop. If browser storage is unavailable, the choice lasts only for the current page.

Completed dictation and cancelled recording retain the warm model. Reloading reinitializes it from cached files. Cancelling model loading or transcription terminates the worker, because synchronous WASM cannot process a cancel message mid-inference; the next use reloads the cached model. Model download size is not a RAM budget. Inference uses additional memory, CPU time, and battery.

The transcript pastes into the same OpenCode prompt without submitting. Pane, viewer, and process checks guard delivery. Session switches cancel stale delivery. Uncertain delivery exposes text for manual recovery, never automatic replay. Check spelling of variable names, paths, and technical terms.

Audio stays local; pasted text goes to the host and submitting it can send it to the agent's provider. Dictation remains OpenCode-only. Missing speech assets do not prevent terminal use; downloads are ignored by Git and prepared separately on a fresh checkout.

## Development

The UI is React, Vite, and xterm.js; the server is Bun with native PTYs. See the [file map](../README.md#mess-with-it). Run `bun run check`, `bun test --no-env-file`, and `bun run build` before sending a patch.

Use a separate tmux socket, state directory, and port. Never point a second server at the production socket: startup reaps old Perch viewers.

```sh
sandbox=$(mktemp -d)
PORT=14310 TMUX_SOCKET="$sandbox/tmux.sock" \
STATE_DIR="$sandbox/state" \
DEV_ORIGIN=http://127.0.0.1:5173 bun --no-env-file server/index.ts
```

In another shell run `PORT=14310 bun run dev`. Vite proxies to that backend. Agent CLIs still use your account's credentials unless you isolate their homes; don't launch real agents accidentally. Never deploy Vite's development server as your terminal gateway.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Exact browser-facing origin; private HTTPS remotely |
| `HOST` | Listen address, default `127.0.0.1`; not an allowed-origin setting |
| `PORT` | Listen port, default `4310` |
| `OPENCODE_BIN` / `CODEX_BIN` / `DEEPSEEK_BIN` / `PI_BIN` | CLI executable path or PATH name |
| `CODEX_HOME` / `DSH_HOME` | Optional absolute agent config/history directories |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Optional provider keys in the private service environment |
| `PROJECTS_ROOT` | Base for relative session paths, default home; not a sandbox |
| `TMUX_SOCKET` | Alternate socket; keep test and production servers separate |
| `STATE_DIR` | Private uploads, default `.state`; no session metadata is written |
| `DIST_DIR` | Frontend build directory, default `dist` |
| `DEV_ORIGIN` | Extra exact development origin; omit in production |

Relative config paths resolve from the checkout; `~/` expands to home. Origins must not contain credentials, a path, query, or fragment. Executable/home overrides are literal; use absolute paths for non-PATH executables and agent homes.

The API accepts any accessible directory, including symlinks outside `PROJECTS_ROOT`. Clients must send `createDirectory: true` to create a missing path. Blank names are generated. Paths and prompts are not shell-expanded.

## Operations

```sh
systemctl --user status agent-watch.service
journalctl --user -u agent-watch.service -n 50 --no-pager
systemctl --user restart agent-watch.service
tailscale serve status
```

Restart Perch, not agents, when only the web app changes. An administrator can enable systemd lingering for service lifetime after logout. Perch does not change it or recover agents after reboot.

To stop hosting, disable only the route assigned to Perch and run `systemctl --user disable --now agent-watch.service`. Don't use `tailscale serve reset` or `tmux kill-server` as an uninstaller; those affect unrelated work.

Ordinary tests use disposable fixtures with no model calls. Any real model task requires permission and can cost money. [Verification](verification.md) separates fixture results from actual device/agent checks; [release notes](release.md) track the remaining publication work.
