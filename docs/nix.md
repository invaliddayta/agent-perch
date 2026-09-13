# Nix package and app

[Overview](../README.md) / [Security](../SECURITY.md) / [Releases](release.md)

From this checkout, with flakes enabled:

```sh
nix build
nix run
```

Outputs `packages.<system>.agent-perch` (also `default`) and `apps.<system>.default` support `x86_64-linux` and `aarch64-linux`. The package includes the frontend, Bun, tmux, shell utilities, and local integrations. Install and authenticate agent CLIs separately; they are resolved from the invoking environment's PATH or `*_BIN` settings. This is not a NixOS module and installs no services, proxy routes, firewall rules, or agent configuration.

The default listener is `127.0.0.1:4310`. Set `HOST`, `PORT`, and exact `PUBLIC_ORIGIN` through the process/service environment as described in the [manual](guide.md#private-remote-access). The package deliberately uses `--no-env-file --no-install`: it never loads a checkout or project `.env`. Provider keys belong in private service configuration, not the store.

## Writable state

The store is read-only. The wrapper sets `STATE_DIR` to `$XDG_STATE_HOME/agent-perch`, or `$HOME/.local/state/agent-perch` when XDG state is unset. An explicit `STATE_DIR` wins. Use absolute external paths for state and any CLI config/session overrides. Upload directories are private and created on first use; DSH launch overlays are created on launch. Agent sessions/config remain in their own external homes. `DIST_DIR` defaults to the packaged frontend, not the current directory. No dependencies, adapters, or models are downloaded at runtime by the package.

Keep the package rooted while running agents use its launch-scoped integrations (for example through a profile or service configuration). Replacing the web service does not restart native agents; do not garbage-collect their adapter paths prematurely.

## Reproducibility

`flake.lock` pins nixpkgs, including Bun **1.3.13**. `bun.lock` pins the JavaScript graph with integrity hashes; `packageManager` records the development Bun version. A fixed-output derivation installs that lock with scripts disabled and all CPU/OS optional packages selected, making its output independent of the build host architecture. The recursive dependency hash is in `flake.nix`. Only this fixed-output fetch can access the registry; frontend compilation and TypeScript validation run offline in the Nix sandbox. Dependency executables are invoked through pinned Bun rather than `/usr/bin/env` shebangs.

For an intentional dependency update: update `bun.lock`, replace the dependency `outputHash` temporarily with `pkgs.lib.fakeHash`, build once to obtain the recursive hash, restore that exact hash, and build again. Review lock and hash changes together. Do not bypass integrity/frozen-lock checks. Updating nixpkgs requires an intentional `flake.lock` update too.

The package includes third-party license notices generated from locked packages. Optional speech model/runtime assets are omitted; `voice:prepare` is not part of the build. Preparing or deploying voice is separate work.

## Isolated verification

```sh
bun install --frozen-lockfile
bun run check
bun test --no-env-file
bun run build
nix build
PERCH_TEST_PACKAGE_BIN="$PWD/result/bin/agent-perch" \
  bun test --no-env-file tests/pi-terminal.test.ts tests/backend-integration.test.ts
```

The last test launches the installed wrapper with a fake Pi process, disposable tmux socket, temporary HOME/XDG state, and a random local port. It checks upload, external writable state, guarded paste, and no submission. It never uses a provider or touches existing sessions. Tag CI builds and runs this check on both Linux architectures; local results do not prove hosted CI or an untested architecture passed.
