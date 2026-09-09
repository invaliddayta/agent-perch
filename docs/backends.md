# Agent Setup

[Overview](../README.md) / [Manual](guide.md) / **Agent setup** / [Tested versions](verification.md#tested-versions)

All agents share the terminal viewer, session switcher, keyboard input, and supported clipboard text writes. Their own approval prompts and shortcuts still apply. Perch doesn't bypass those controls.

All three agents run as native terminal programs. Perch observes native events for newly launched sessions, without reading conversation databases, running a separate agent API server, or adding anything to prompts. It does not compact conversations or make approval decisions. Dictation and image-path paste remain OpenCode-only because delivery checks depend on its prompt accepting bracketed paste.

| Agent | Executable | Starting prompt | Native signal |
| --- | --- | --- | --- |
| OpenCode | `opencode` | Supported | Root lifecycle, permissions, questions |
| Codex | `codex` | Supported | Generic needs-attention notification |
| DeepSeek Harness | `dsh-tui` | Enter in the TUI | Root lifecycle and approval events |

> [!NOTE]
> Authenticate each CLI on the host before launching it from Perch. Availability means the executable was found, not that login or a model request has succeeded.

## Directories

Enter an absolute path, `~/...`, or a path relative to `PROJECTS_ROOT` (your home directory by default). The form can create missing directories. It leaves existing files alone and does not run `git init`.

A blank session name uses the directory name, with a suffix if it is already taken. Directory permissions are the host account's normal permissions, not a Perch sandbox.

## OpenCode

Install OpenCode and configure its model provider on the host. Perch runs `opencode <directory>` directly, adding a literal `--prompt=<text>` argument if supplied. Set `OPENCODE_BIN` if it isn't on the service's PATH. No shared API service or password is needed by Perch.

Existing OpenCode tmux sessions still attach normally, including sessions connected to an independently managed OpenCode server. Their server must remain running; Perch does not manage its lifetime.

For new launches, Perch appends its local event plugin through a process-scoped `OPENCODE_CONFIG_CONTENT` overlay, preserving existing inline settings and plugins. It observes root-session lifecycle, permission, and question events, never prompt-transform or approval-decision hooks. Completion is conservative: a successful final reply followed by idle, not silence or startup idle. No user or project config file is rewritten. Disabling external plugins also disables this integration; **No status** is then expected.

Dictation and images enter the prompt without submitting it. Use OpenCode's own `/compact` and other controls in the TUI. [Speech details](guide.md#private-voice).

## Codex

Install Codex CLI and sign in as the same account that runs Perch. On a remote host, the TUI's **Sign in with Device Code** option avoids a localhost browser callback. The separate CLI route is:

```sh
codex login --device-auth
```

Set `CODEX_BIN` if `codex` isn't on the service's PATH. It must name an executable, not a shell alias or a string with flags. An optional starting prompt is passed as a literal argument; Perch doesn't enable bypass-approval flags.

New launches enable Codex's first-party TUI notifications using runtime-only `--config` settings: `tui.notifications=true`, `tui.notification_method="osc9"`, and `tui.notification_condition="always"`. Perch leaves the user's `notify` command, lifecycle hooks, approval rules, and config files alone. A passive tmux control client observes notifications even when no browser is viewing the session. It emits **Needs attention**, not a guessed event type based on assistant text. Native notifications cover turn completion, approvals, and questions; this path does not supply a reliable busy/idle state or every error. Use the TUI for the details.

Observer startup, retry, and dead-pane cleanup belong to the server, independently of session-list requests. Restarting the web service reattaches observers for still-valid tagged panes; it does not instrument older untagged agents or replay notifications missed during downtime.

## DeepSeek Harness

The launcher is **`dsh-tui`**. The independent [dsh-tui Nix package](https://github.com/invaliddayta/dsh-tui-nix) packages the Harness and TUI from pinned sources for Linux ARM64 and x86-64. Follow that repository's installation instructions; Perch does not build or install it for you.

Set `DEEPSEEK_BIN` to a durable executable path visible to the service. With Nix, use a profile or keep the build output rooted. A bare store path can disappear during garbage collection. Don't put `nix run ...` in `DEEPSEEK_BIN`; that field takes a path, not a command line.

Configure `DEEPSEEK_API_KEY` privately on the host. `/model` opens the TUI's model selector. There is no starting-prompt CLI flag in this integration, so enter the prompt after launch.

DeepSeek runs directly in the supplied directory. Perch passes a launch-scoped `--patch` overlay that adds its local Cordis observer. The patch lives under `STATE_DIR/integrations`; the user's profile and `DSH_HOME` configuration are not rewritten. Root-turn lifecycle and approval audit events supply status. Question observation delegates unchanged to the native question handler; Perch never answers or grants permission. [Tested package versions](verification.md#tested-versions).

## Environment and Services

| Setting | Use |
| --- | --- |
| `OPENCODE_BIN` | Executable path or PATH name; defaults to `opencode` |
| `CODEX_BIN` | Executable path or PATH name; defaults to `codex` |
| `DEEPSEEK_BIN` | Executable path or PATH name; defaults to `dsh-tui` |
| `CODEX_HOME` | Optional Codex config/auth directory; use an existing absolute directory |
| `DSH_HOME` | Optional DeepSeek profile/history directory; use an absolute path |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | Provider keys, if using key-based auth; keep private |

Exporting a key in your shell does not give it to an already-running systemd service. Put it in the private service environment or `.env`, restart only `agent-watch.service`, and create a **new** agent session. Already-running agents keep their old environment.

The installer preserves an existing `.env`. When creating one, it carries over executable and home-directory overrides, but does not copy provider keys from your shell. A temporary development shell's PATH may not be suitable for a long-running service.

To install Perch's single web service:

```sh
bun run install:service --dry-run
bun run install:service
```

This doesn't authenticate agents or stop an existing OpenCode service. You can also [run Perch in the foreground](guide.md#without-systemd).

## When a CLI Exits

The agent is the process in its tmux pane. If it exits and tmux isn't retaining dead panes, the session can disappear. Perch does not restart it automatically. Check the CLI's own diagnostics and authentication before launching another session; repeated launches are not proof that login succeeded.
