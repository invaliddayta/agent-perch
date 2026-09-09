# Hacking on Perch

[Overview](README.md) / **Contributing** / [Verification](docs/verification.md) / [Security](SECURITY.md)

Small patches are welcome. Fixing an awkward key binding is a perfectly good contribution. Not every improvement needs a new subsystem.

## Before Sending Code

Contributions are made under the project's [MIT license](LICENSE). Only send work you have the right to contribute, and retain any required third-party notices. There is no separate CLA or DCO requirement.

## Run the Checks

Linux, Bun 1.3.10+, and tmux 3.3+:

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
```

The tests use disposable directories and separate tmux sockets. They do not need provider keys. Optional real-CLI smoke checks are described in [verification](docs/verification.md).

For browser regressions, run `bun run dev` and open `/tests/browser.html` on that dev server. It reports PASS lines or a failure stack. These checks use real React and xterm with fake HTTP, WebSocket, microphone, and speech-worker fixtures; they never launch agents or contact a backend. They cover attachment invalidation, snapshot races, dictation and image delivery, remembered speech startup and opt-out, session dialogs, and native audio decoding/resampling with generated WAVs. This browser suite is separate from `bun test` and is not included in production builds.

The Bun suite also runs the actual speech worker with a fake inference module and checks that production builds do not emit duplicate WASM. Neither check needs downloaded models or a GPU.

For manual testing, use a separate `TMUX_SOCKET`, `STATE_DIR`, and port too. Don't test cleanup on a session somebody is using. Don't restart a deployed service to see whether your patch works. The [development setup](docs/guide.md#development) keeps those worlds apart.

Real model prompts can cost money; run them only with explicit permission. Speech preparation downloads files and isn't needed for ordinary terminal changes.

## Keep These Properties

- Private network access is the security boundary. Origin checks are not a login system.
- A running terminal is not proof that an agent is ready. Leave conversation status, compaction, and approvals in the agent's own TUI.
- Never retry uncertain input automatically. Sending the same prompt twice is not a recovery strategy.
- Preserve existing tmux sessions, deployment names, and private configuration.
- Test UI changes on a narrow screen, with keyboard navigation and reconnects, not just a wide screenshot.
- Keep new agent arguments literal. Don't turn a path or prompt into a shell command.
- Keep viewer lifetimes separate from agent lifetimes. Native pane notifications must invalidate old paste targets, including rapid round trips.
- Keep attention reconciliation server-owned. A session-list request must not create or destroy observers.

> [!TIP]
> **Delete a responsibility before adding an abstraction.** Prefer native tmux/browser behavior, one owner per resource, and explicit failure handling. The README's [file map](README.md#mess-with-it) is the starting point.

## Bugs and Pull Requests

Tell us what you tried, what happened, what should have happened, and which backend/browser versions were involved. A short reproduction in a throwaway directory beats a full conversation export.

List the checks you actually ran. If a feature was tested with a fake agent or an emulated phone, say so. Those are useful tests; they just aren't live provider or hardware tests.

Review screenshots and logs for keys, prompts, private paths, and clipboard contents. Don't attach `.env`, state databases, uploads, or raw conversation histories. For vulnerabilities, use the [private reporting route](SECURITY.md#reporting), not a public issue.
