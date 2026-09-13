import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { thirdPartyNotices } from "./third-party-notices";

export function releaseVersion(tag: string, version: string): string {
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) ||
    tag !== `v${version}`
  )
    throw new Error("Release tag must be v<package.json version>.");
  return version;
}

export async function packageRelease(
  root: string,
  output: string,
  tag: string,
) {
  const manifest = await Bun.file(join(root, "package.json")).json();
  const version = releaseVersion(tag, manifest.version);
  if (!(await Bun.file(join(root, "dist/index.html")).exists()))
    throw new Error("Build the frontend first.");
  const temp = await mkdtemp(join(tmpdir(), "perch-release-"));
  const name = `agent-perch-${version}`;
  const stage = join(temp, name);
  try {
    await mkdir(stage);
    // Allowlist: never archive a checkout, private state, node_modules, or .env.
    for (const path of [
      "server",
      "src",
      "integrations",
      "dist",
      "package.json",
      "bun.lock",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "docs",
      "scripts/launch-agent.sh",
      "scripts/await-observer.ts",
    ])
      await cp(join(root, path), join(stage, path), { recursive: true });
    // A developer may have prepared speech locally; releases always omit it.
    for (const path of ["models", "speech", "ort"])
      await rm(join(stage, "dist", path), { recursive: true, force: true });
    await mkdir(join(stage, "bin"));
    await writeFile(
      join(stage, "bin/agent-perch"),
      `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export STATE_DIR="\${STATE_DIR:-\${XDG_STATE_HOME:-$HOME/.local/state}/agent-perch}"
exec bun --no-env-file --no-install "$root/server/index.ts" "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(stage, "THIRD_PARTY_NOTICES.txt"),
      await thirdPartyNotices(root),
    );
    await writeFile(
      join(stage, "RUNNING.txt"),
      `Agent Perch ${version}\nRequires Linux, Bun 1.3.10+ and tmux 3.3+. Agent CLIs are installed separately.\nNo dependency install or runtime download is needed for this prebuilt distribution.\n\nRun from this directory:\n  ./bin/agent-perch\n\nState defaults to $XDG_STATE_HOME/agent-perch or $HOME/.local/state/agent-perch; STATE_DIR overrides it.\nDefault: http://127.0.0.1:4310. Set HOST/PORT/PUBLIC_ORIGIN through the environment.\nThere is no login. Use a private authenticated HTTPS reverse proxy with WebSockets.\nSee docs/guide.md and SECURITY.md. Speech assets are not included.\nKeep this directory while any agents use its launch-scoped integrations.\n`,
    );
    await mkdir(output, { recursive: true });
    const archive = join(output, `${name}-runtime.tar.gz`);
    const tar = Bun.spawn(
      [
        "tar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archive,
        "-C",
        temp,
        name,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (await tar.exited)
      throw new Error(await new Response(tar.stderr).text());
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(archive).arrayBuffer())
      .digest("hex");
    await writeFile(
      join(output, "SHA256SUMS"),
      `${hash}  ${name}-runtime.tar.gz\n`,
    );
    return archive;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      "Usage: bun scripts/package-release.ts <output-directory> <vVERSION>",
    );
  console.log(
    await packageRelease(
      process.cwd(),
      resolve(process.argv[2]),
      process.argv[3],
    ),
  );
}
