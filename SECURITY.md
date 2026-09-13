# Security

[Overview](README.md) / **Security** / [Private deployment](docs/guide.md#private-remote-access)

> [!CAUTION]
> **Reachable means controllable.** There is no built-in login, user separation, or sandbox. Perch is a personal tool for a trusted network, not a public terminal service.

## Deployment

- The server binds to `127.0.0.1`. For remote access, use private HTTPS with access control, such as Tailscale Serve or an authenticated reverse proxy.
- Never use Tailscale Funnel or expose an unauthenticated proxy to the internet. Run as your normal user, not root.
- Restrict the network/proxy policy to people and devices you trust with that account. A tailnet is not automatically a one-person network.
- Host/Origin checks and mutation headers block cross-site requests. They do not authenticate users.
- Paths use the account's filesystem permissions. `PROJECTS_ROOT` is a base for relative paths, not a boundary. Agents can access what their account can access.
- Treat `OPENCODE_BIN`, `CODEX_BIN`, `DEEPSEEK_BIN`, `PI_BIN`, wrapper scripts, and the service's `PATH` as trusted configuration. Don't let untrusted users replace those executables.

## Data

Keep `.env`, `.state`, uploads, databases, and logs out of Git. Standard locations are ignored; custom state/build directories need their own ignore rules. Review the actual files before pushing.

Terminal output is rendered as text, not HTML. Perch does not maintain an offline shell cache or cache terminal output/API responses. A compatibility service worker clears only retired Perch shell caches; Moonshine's model cache remains separate. Clipboard bridging accepts supported writes from the displayed pane, never clipboard-read requests. An observer failure disconnects its viewer rather than trusting stale pane metadata. This is not a promise that browsers or agent CLIs keep no history.

Native attention adapters store only coarse states and random event IDs in tmux pane options. Codex's passive notification observer discards notification text; browser acknowledgments contain identifiers only. These signals are informational, not an approval or authentication boundary: terminal programs under the host account can emit notifications. Perch never acts on them automatically or injects instructions into prompts. The DSH launch overlay is generated under `STATE_DIR/integrations`, not in the user's agent profile.

**Recorded speech stays on the viewing device.** Moonshine runs in a browser worker. Prepared model/runtime files come from the host; there is no remote transcription fallback. The resulting transcript is pasted into the host's OpenCode prompt. Submitting it can send it to the model provider. Other agent prompts and project contents may also go to their configured providers.

The browser remembers the speech-startup preference, not recordings. Background preparation never requests microphone access. Threaded WASM requires cross-origin isolation; only speech-worker/pthread script responses permit Emscripten's `unsafe-eval`. The main page keeps its stricter CSP and same-origin connection policy.

Pasted images are uploaded to private files under `STATE_DIR/images`, not served as public web files. Files older than 24 hours are removed on a later upload, not by a scheduled expiry job. OpenCode may keep submitted attachments in its own history. Pi receives a host file reference and may read it with its native tools after manual submission. Pi lifecycle integration is opt-in and observes only coarse events, never approval decisions. See [image handling](docs/guide.md#clipboard-images).

## Reporting

Don't post exploitable details or credentials in a public issue.

If the repository has **Security > Report a vulnerability**, use it. **Private vulnerability reporting still needs to be enabled when the GitHub repository is created.** No private email address is published yet. If neither route is available, ask the maintainer for a private channel without including the vulnerability details.

Include the affected revision, host/browser/backend versions, impact, and a minimal redacted reproduction. Don't test against another person's host or working sessions.

There is no response-time guarantee or supported-version policy yet. Passing tests should not be mistaken for a security audit.
