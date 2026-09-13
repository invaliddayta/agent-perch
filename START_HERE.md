# First Run

[Overview](README.md) / **First run** / [Manual](docs/guide.md) / [Agent setup](docs/backends.md)

**One host. One web service. Your existing terminals.**

| Before you start | Required |
| --- | --- |
| Host | Linux, Bun 1.3.10+, tmux 3.3+ |
| Account | The normal user who owns your sessions, never root |
| Agents | Install and authenticate only the CLIs you want to launch |

## Try It

From the checkout:

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

Open **http://localhost:4310/**. Existing tmux sessions appear automatically. To start an agent, choose **New session**, enter a directory, and pick a backend. A missing directory can be created; a blank name uses the directory name.

This starts only Perch. All four agents run directly in tmux, without a separate API service. See [backend setup](docs/backends.md).

## Keep It Running

Stop the foreground server before starting a service on the same port:

```sh
bun run install:service --dry-run
bun run install:service
```

The installer needs systemd user services. It creates a private `.env` if one is missing, but does not replace an existing one or restart already-running services.

The web service is still named `agent-watch.service` for existing installations. No OpenCode service is installed or changed. [Setup and upgrade details](docs/guide.md#quick-start).

## Use Another Device

> [!WARNING]
> **Perch has no login.** Keep it on localhost or use [private HTTPS with access control](docs/guide.md#private-remote-access). With Tailscale, use Serve, never Funnel. Anyone who can reach it can control your terminals.

Open the private URL on your device. A browser tab works. Installation is optional: use Chromium's install menu, or Safari's **Share > Add to Home Screen** on iOS. Perch no longer caches an offline app shell; you need a connection to the host.

## Optional Dictation

```sh
bun run voice:prepare
bun run build
```

This downloads the speech assets onto the host. Your browser then fetches about 304 MiB from that host on first use and caches the model. Moonshine Medium transcribes English on the device with the microphone; Perch does not upload recorded audio or call a transcription service.

Click **Settings > Prepare speech** or use dictation once. Perch then remembers to prepare speech in the background on future visits, without opening the microphone. Turn off **Prepare speech on startup** in Settings if you prefer manual loading.

Dictation currently pastes text into OpenCode only. It does not press Enter. Read the transcript before sending it to the agent. [Speech details](docs/guide.md#private-voice).

> [!TIP]
> Prepare the model while you choose a session. Background preparation never opens the microphone, and the warm model is reused for subsequent dictation.

## A Few Useful Controls

- **Ctrl+Alt+S** opens session search. Type to filter; use arrows and Enter to choose. Escape closes the search.
- Tap a mobile terminal to bring up the keyboard. The touch strip supplies the keys phone keyboards forgot.
- **Settings > Fit the terminal to this screen** controls whether this viewer can resize the terminal.
- The **red X** beside a session opens a confirmation before killing its running work. Cancel leaves it alone.
- New OpenCode/Codex/DSH sessions report native turn-finished/attention events; Pi reporting is opt-in with `PI_ATTENTION=1` ([setup](docs/backends.md#pi)). Check the unread dots, banner, and tab count; **Mark seen** acknowledges them. **No status** means no native signal is available, not that the agent is idle. Read its TUI for approval and compaction controls.
- Clipboard writes may need a tap on **Copy to clipboard** if the browser blocks automatic copying.

If something fails, [report a small, redacted reproduction](CONTRIBUTING.md). Please leave your API keys out of the screenshot.
