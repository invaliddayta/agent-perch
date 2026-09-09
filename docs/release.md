# Release Checklist

[Overview](../README.md) / [Verification](verification.md) / **Release checklist** / [Security](../SECURITY.md)

**Target: a source-only, single-user preview.** No public terminal gateway, bundled model download, or claim of universal phone support.

> [!IMPORTANT]
> A polished README is not a release gate. Check the actual source, installation path, and reporting route before publishing.

## Before the First Public Push

- [x] **Source rights and license.** Author ownership confirmed; [MIT](../LICENSE) is in place. Third-party notices retain their own terms.
- [x] **Dependency advisories.** Removing Transformers.js also removed the affected Node/image dependency tree. The current `bun audit` reports no vulnerabilities.
- [x] **Source and repository privacy checks.** Gitleaks 8.30.1 found no credential matches in the physical checkout, history, or decoded Git objects on 2026-09-09. Separate inspection found device references in the unpublished history; these were removed by replacing it with a clean initial commit. Screenshots contain inert fixtures and generic paths. Repeat after further edits and before the public push.
- [x] **Clean installation.** The current export passed frozen install, TypeScript, 82 tests / 941 assertions, and production build on the x86-64 host, without private configuration or prepared speech files. Assets were copied in afterward.
- [ ] **Public DeepSeek installation.** Verify the tested worker-limit packaging fix from a named public revision in its own repository.
- [ ] **Repository destination.** Owner/name selected: `invaliddayta/agent-perch`. Configure the remote when ready to publish. Only then add real clone links and hosted CI links.
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
