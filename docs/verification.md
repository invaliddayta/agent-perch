# Verification

[Overview](../README.md) / [Manual](guide.md) / **Verification** / [Release checklist](release.md)

**Fork checks: 2026-09-13.** The table and fork section below describe local results; the deployment and speech measurements are retained upstream observations from 2026-09-09, not deployments or model runs performed for this fork.

> [!NOTE]
> Local tests are evidence, not a hosted CI badge or a security audit. Hardware microphones, physical phones, and authenticated model tasks are separate checks.

## Current Checks

| Check | Result | Boundary |
| --- | --- | --- |
| TypeScript and production build | Pass | Existing large-chunk warning remains |
| Bun suite | **90 pass / 1036 assertions**, 1 optional skip | 21 files; isolated sockets and inert agents |
| Dependency audit | No vulnerabilities reported | Current lockfile, not a supply-chain guarantee |
| Privacy checks | Gitleaks 8.30.1: no credential matches | Physical checkout, history, and decoded Git objects; device references and screenshots reviewed separately |
| Browser regressions | **13 groups pass** | Real React/xterm; mocked transports, capture, inference |
| Real English inference | Pass | Public audio fixtures, no hardware microphone |
| Hosted GitHub Actions | Not run | Workflows added locally; no push/tag/release performed |
| Nix package | Pass, Linux x86-64 | Locked offline build and installed-wrapper fake-agent smoke tests; ARM64 evaluated only |

### Fork Validation Boundaries

Pi integration was based on the installed **0.85.1** documentation and actual CLI parser, clipboard implementation, extension loader, and process-title code. The installed parser passed literal `@`, leading-option, whitespace and newline cases without launching Pi. The installed extension loader accepted the local adapter and registered all six intended hooks without a session or provider. Lifecycle unit tests use fake events; native terminal integration tests use inert agents on disposable tmux sockets.

Pi images are **host file references**, not automatically attached image bytes. Tests cover quoted paths, control-character rejection, backend/target changes, upload cleanup, bracketed paste, and no Enter. Headless Chromium ran all 13 real React/xterm fixture groups, including the new Pi upload flow. Hardware phones, real approval extensions, authenticated model tasks, and Pi reading a submitted image have **not** been exercised.

The locked Nix package built on x86-64, and its installed launcher passed isolated upload/paste and all-four-backend launch tests with fake CLIs. The runtime tarball passed SHA-256 verification and the same smoke checks after extraction without `node_modules`. Package smoke checks omit PATH-based tmux fault injection because the Nix wrapper deliberately pins tmux; ordinary source tests retain those faults. ARM64 package evaluation succeeded; builds and hosted release publication remain for CI. No live service, private config, existing tmux session, or deployment host was changed, and no optional speech model was downloaded.

### Terminal and Observer Lifetimes

- A real isolated tmux viewer issues **zero pane-query subprocesses during an idle 1.25-second check**. Native window/pane notifications replace the former one-second query per viewer. Startup, window changes, and sensitive delivery still use targeted queries.
- Rapid pane and window round trips invalidate old paste destinations. Unrelated windows do not invalidate a separate viewer. Pane output cannot impersonate native metadata. A lost viewer observer closes that WebSocket with code 1011; another viewer and the original process survive.
- Attention observers attach on server startup without any browser or HTTP request. A 12-request session-list burst does not duplicate them. Killing an observer triggers recovery without browser polling; retained dead panes are cleaned up. One serialized, server-owned reconciliation loop runs every 3.5 seconds.
- Existing regressions cover read-only input, terminal responses, guarded non-submitting paste, uncertain-delivery recovery, session identity changes, concurrent kill/attach, private uploads, and preservation of unrelated sessions. No provider prompts are used.

### Browser and Cache Behavior

The browser suite covers session snapshot races, attachment invalidation, dialogs, image/dictation delivery, microphone release, native audio decoding at 8/16/44.1/48 kHz, startup preference persistence, opt-out, and failed-load recovery. It runs separately at `/tests/browser.html` on Vite; it is not yet part of hosted CI.

The offline-shell fetch handler has been removed. A compatibility worker retires only `agent-watch-shell-*` caches. Both the script regression and an actual Chromium registration/activation test confirm that speech and unrelated caches survive. Browser-menu installation remains the intended route; physical installation and suspend/resume are not verified.

Earlier current-UI checks covered 1440x900, 390x844, 375x400, and 320x568, including touch controls, Escape/fullscreen fallbacks, dialog reachability, and no horizontal overflow. This pass refreshed the manager and terminal screenshots from the actual production build, with inert fixtures, generic project paths, and a 390x844 mobile view. No real agent conversations appear in them.

All eight Markdown pages passed a local render check at mobile width. All 89 local links/assets/anchors resolved. Long revision hashes use scrollable code blocks rather than overflowing inline text. The README was visually checked at desktop width with the current screenshots and its self-contained pixel-bird banner; this is a GitHub-style local preview, not a hosted GitHub render.

## Deployment Check

A clean source export passed frozen install, TypeScript, all 82 tests / 941 assertions, and build before activation on Linux x86-64. Only the web service restarted. Existing sessions and pane PIDs, private configuration, and the independently running legacy API process were preserved.

Private HTTPS passed a real read-only WebSocket handshake without sending input or recording terminal output. Cross-origin isolation, prepared speech assets, and the retired shell-cache handler were verified. The existing browser model cache survived the service-worker update.

Rollback restores the preceding web-service configuration, not session state. Hostnames, paths, release identifiers, and rollback checkpoints belong in private deployment records, not this repository. Keep releases referenced by still-running agent adapters.

## Speech Checks

**Moonshine v2 Medium English**, 245M parameters, quantized revision `quantized_26_07_30`, pinned WASM runtime **0.1.5**. Prepared model/runtime assets total **303.67 MiB**. The model includes a floating-point frontend.

| Fixture on the Linux ARM64 test machine | Observation |
| --- | --- |
| 11-second public JFK clip, fresh worker | 23.9 seconds |
| Same clip, warm repeat | 5.2 seconds; an earlier run took 4.6 seconds |
| 52-second fixture with four spaced repetitions | 54.0 seconds; all four retained |
| Silence | Empty transcript, 6 ms |
| Same short clip through private HTTPS | 11.0 seconds download/load, 22.7 seconds inference |

The short clip reproduced the spoken words with different punctuation. Browser runtime requests stayed same-origin. These are smoke measurements, not representative WER, memory, battery, or phone benchmarks.

Real startup-preference testing confirmed: a first visit loaded no worker; explicit preparation saved the preference; reload prepared exactly one worker; opt-out prevented loading on the next reload. Every preparation-only path made **zero microphone requests**. Recordings remain local and transcripts paste without Enter.

Threaded WASM requires COOP/COEP isolation. Tests check that Emscripten's `unsafe-eval` permission is scoped to speech-worker/pthread responses, not the page. Model selection stays English regardless of browser language. There is no cloud, GPU, or smaller-model fallback.

The [Moonshine v2 paper](https://arxiv.org/abs/2602.12241) reports 6.65% average English WER for floating-point Medium. That motivates the model choice; it is **not** a benchmark of this quantized browser build.

## Tested Versions

| Component | Observed version |
| --- | --- |
| Hosts | Linux ARM64 and x86-64 |
| Bun | 1.3.10 locally; 1.3.14-canary.1 on the private host |
| tmux | 3.7b locally; 3.6a on the private host |
| OpenCode | 1.18.3 locally; 1.18.4 on the private host |
| Codex CLI | 0.151.0 |
| DeepSeek Harness / TUI | 0.1.2-rc.1 / 0.1.2 |

CLI startup smoke checks used disposable homes without credentials. The tested DeepSeek package's local worker-limit fix still needs a reproducible public installation check.

<details>
<summary>Exact DeepSeek packaging revisions</summary>

```text
Harness   76fda729799fe9b3848dbe2c211d4b231032b81e
TUI       8bdc850732464e2c10278f47b4f2b82da38d801e
Nixpkgs   3ed67ec0a4d3c7ab4ae1f04f8ee8df07bfa506a2
```

</details>

## Reproduce

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
```

For browser fixtures, run `bun run dev` and open `/tests/browser.html`. For optional credential-free installed-CLI startup checks:

```sh
PERCH_TEST_CODEX_BIN="$(command -v codex)" \
PERCH_TEST_DEEPSEEK_BIN="$(command -v dsh-tui)" \
bun test --no-env-file tests/backend-integration.test.ts
```

`PERCH_TEST_DSH_RUNTIME` can point to an installed runtime's `node_modules/@deepseek-ai` directory for the optional Cordis compatibility test. Without these overrides, no sibling checkout or installed agent is required.

## Remaining Limits

- Physical iOS/Android microphone, installation, keyboard, suspend/resume, RAM, and battery testing.
- Coding vocabulary, accents, noisy audio, and representative speech accuracy measurements.
- Authenticated model tasks, approvals, and cancellation in disposable sessions for each backend.
- Host reboot recovery and nicer failed-launch diagnostics. Neither is currently promised.
- Final publication scans, hosted CI, and distribution notices. See the [release checklist](release.md).

The initial terminal-first simplification removed about 42% of implementation lines. Later passes removed duplicate runtime/dependency paths and recurring work. Those historical reductions are not a current speedup claim: the main JavaScript bundle is still about **597 kB / 167 kB gzip**, plus optional speech assets. No general idle CPU/RSS benchmark has been run.

## Source Origin

The checkout began from `agent-watch-0f91bd5-source.zip`, identifying source commit:

```text
0f91bd53beea8db465cd3df2c9f1824d7263e509
```

The author confirmed full ownership and chose [MIT](../LICENSE). Third-party software retains its own terms.
