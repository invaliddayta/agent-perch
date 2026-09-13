# Release Checklist

[Overview](../README.md) / [Verification](verification.md) / **Release checklist** / [Security](../SECURITY.md)

**Target: a single-user preview with a pinned Nix package and prebuilt runtime archive.** No public terminal gateway, bundled model download, or claim of universal phone support.

## Versioned Fork Releases

The fork is `tompro/agent-perch`; upstream is `invaliddayta/agent-perch`. Nothing is published by a local build. After review, a maintainer may deliberately push a version tag matching `package.json`, for example `v0.1.0` (prerelease suffixes are allowed). The `Versioned release` workflow rejects mismatched tags, then runs frozen Bun install, TypeScript, fake-agent/disposable-tmux tests, frontend build, and `nix build` on Linux x86-64 and ARM64. It tests the installed Nix wrapper, packages the runtime, and only after both validation jobs pass creates a GitHub release with:

- `agent-perch-<version>-runtime.tar.gz`: prebuilt frontend, TypeScript server, local adapters, launcher, docs and third-party notices. Architecture-independent application files; **Linux with Bun 1.3.10+ and tmux 3.3+ must already be installed**. Agent CLIs/authentication are separate. No npm install is needed to run it.
- `SHA256SUMS`: SHA-256 of the runtime archive. Checksums detect corruption; they are not a signature or authentication mechanism.

Hosted CI/release publication has not been exercised locally. Tags are a publication action; do not use a tag push as a dry run. CI action references currently use major-version tags rather than immutable SHAs. Browser/hardware and authenticated model checks remain separate gates.

Download both assets from the intended release, verify and unpack:

```sh
sha256sum --check SHA256SUMS
tar -xzf agent-perch-0.1.0-runtime.tar.gz
cd agent-perch-0.1.0
./bin/agent-perch
```

Substitute the downloaded version. The launcher uses Bun with `--no-env-file --no-install`: no ambient `.env` load or automatic runtime dependency download. It defaults writable state to `$XDG_STATE_HOME/agent-perch` or `$HOME/.local/state/agent-perch`; an absolute `STATE_DIR` overrides it. Default `HOST=127.0.0.1`, `PORT=4310`. Configure private environment variables and an authenticated HTTPS/WebSocket reverse proxy explicitly; see [the manual](guide.md#private-remote-access). There is no login or automatic deployment.

Keep old distribution directories while agents use their adapters. Do not replace or kill existing agent sessions to upgrade the web service. The archive deliberately omits `.env`, state/uploads, `node_modules`, and all prepared speech models/runtime assets. Built dependency and font notices are in `THIRD_PARTY_NOTICES.txt`. The [Nix package](nix.md) is an alternative; it is not a portable tarball of Nix store paths.

For a local packaging dry run, use a directory outside the checkout (no publishing):

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
output=$(mktemp -d)
bun scripts/package-release.ts "$output" "v$(bun -p 'require("./package.json").version')"
(cd "$output" && sha256sum --check SHA256SUMS)
```

The older checklist below records upstream preview work; dated results do not certify changes in this fork.

> [!IMPORTANT]
> A polished README is not a release gate. Check the actual source, installation path, and reporting route before publishing.

## Before the First Public Push

- [x] **Source rights and license.** Author ownership confirmed; [MIT](../LICENSE) is in place. Third-party notices retain their own terms.
- [x] **Dependency advisories.** Removing Transformers.js also removed the affected Node/image dependency tree. The current `bun audit` reports no vulnerabilities.
- [x] **Source and repository privacy checks.** Gitleaks 8.30.1 found no credential matches in the physical checkout, history, or decoded Git objects on 2026-09-09. Separate inspection found device references in the unpublished history; these were removed by replacing it with a clean initial commit. Screenshots contain inert fixtures and generic paths. Repeat after further edits and before the public push.
- [x] **Clean installation.** The current export passed frozen install, TypeScript, 82 tests / 941 assertions, and production build on the x86-64 host, without private configuration or prepared speech files. Assets were copied in afterward.
- [ ] **Public DeepSeek installation.** Verify the tested worker-limit packaging fix from a named public revision in its own repository.
- [x] **Repository destination.** Fork origin is `tompro/agent-perch`, with read-only upstream reference `invaliddayta/agent-perch`. Local implementation does not push or publish.
- [ ] **Private security reporting.** Enable GitHub private vulnerability reporting or publish a monitored private contact. Update [SECURITY.md](../SECURITY.md#reporting).

## Before Tagging the Preview

- [ ] Green hosted CI on minimum and latest Bun; local results do not substitute for it.
- [ ] Run the browser regression page. Automating it in CI remains follow-up work.
- [ ] Exercise one authenticated task, approval, and cancellation per backend in disposable directories, with explicit permission to spend credits.
- [ ] Check failed launch/login diagnostics and real phone disconnect, reconnect, and suspend/resume. Never replay uncertain input.
- [ ] Review notices for everything actually distributed. The self-hosted font has its [MIT notice](../public/fonts/LICENSE.txt); built JavaScript, WASM, and model weights need their own distribution review.
- [ ] Review the tag, release notes, screenshots, and attachments for private information. State the [known limits](verification.md#remaining-limits).

## Dependency Audit, 2026-09-07

Historical findings, **resolved on 2026-09-09** by removing the affected dependency tree:

| Removed dependency | Advisory |
| --- | --- |
| `adm-zip` 0.5.18 via Transformers.js / Node ONNX | [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) |
| `sharp` 0.34.5 via Transformers.js | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) |

No suppressions or installed-package patches were used. The pinned Moonshine browser runtime replaces that stack.

## Recheck Locally

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
bun audit
```

Export exactly the intended source. Exclude `.env`, `.state`, uploads, databases, logs, dependencies, generated builds, and downloaded speech assets. Scan the export, physical checkout (including ignored files), and all Git objects, including unreachable objects, with redacted output. Review screenshots and Git author metadata separately: credential scanners do not establish that a repository is free of device-specific or personal information.

The publication checkout is source-only; generated files and private recovery archives are kept outside it. Installing dependencies, building, preparing speech, or running the app can recreate ignored files. Re-audit before sharing the entire folder, not just before pushing tracked files.

Nice-to-haves can wait: additional hardware coverage, performance profiling, automatic dependency updates, and SHA-pinned CI actions. No new deployment platform or plugin framework is required to share a useful preview.
