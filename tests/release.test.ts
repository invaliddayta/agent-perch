import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRelease, releaseVersion } from "../scripts/package-release";

test("release tags must match the package version and cannot inject paths or flags", () => {
  expect(releaseVersion("v1.2.3", "1.2.3")).toBe("1.2.3");
  expect(releaseVersion("v1.2.3-rc.1", "1.2.3-rc.1")).toBe("1.2.3-rc.1");
  for (const tag of ["v1.2.4", "main", "v../private", "v1.2.3\n", "--help"])
    expect(() => releaseVersion(tag, "1.2.3")).toThrow("tag");
});

test("runtime release allowlist excludes private files, dependencies and prepared speech, with reproducible checksums", async () => {
  const temp = await mkdtemp(join(tmpdir(), "perch-artifact-"));
  const root = join(temp, "source");
  const output = join(temp, "output");
  try {
    for (const directory of [
      "server",
      "src",
      "integrations",
      "docs",
      "scripts",
      "dist/models",
      "dist/speech",
      "dist/ort",
      "public/fonts",
      "node_modules/fixture",
      ".state",
    ])
      await mkdir(join(root, directory), { recursive: true });
    for (const file of [
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "bun.lock",
      "scripts/launch-agent.sh",
      "scripts/await-observer.ts",
      "dist/index.html",
      "public/fonts/LICENSE.txt",
      "node_modules/fixture/LICENSE",
    ])
      await writeFile(join(root, file), "fixture\n");
    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
    await writeFile(
      join(root, "node_modules/fixture/package.json"),
      '{"name":"fixture","version":"1.0.0","license":"MIT"}',
    );
    for (const file of [
      ".env",
      ".state/private",
      "dist/models/model.bin",
      "dist/speech/runtime.wasm",
      "dist/ort/old.wasm",
    ])
      await writeFile(join(root, file), "PRIVATE_OR_OPTIONAL");
    const archive = await packageRelease(root, output, "v1.2.3");
    const first = await readFile(join(output, "SHA256SUMS"), "utf8");
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(archive).arrayBuffer())
      .digest("hex");
    expect(first).toBe(`${hash}  agent-perch-1.2.3-runtime.tar.gz\n`);
    const tar = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe" });
    const files = await new Response(tar.stdout).text();
    expect(await tar.exited).toBe(0);
    expect(files).toContain("agent-perch-1.2.3/dist/index.html");
    expect(files).toContain("agent-perch-1.2.3/THIRD_PARTY_NOTICES.txt");
    expect(files).toContain("agent-perch-1.2.3/RUNNING.txt");
    expect(files).not.toMatch(
      /\.env|\.state|node_modules|dist\/(models|speech|ort)/,
    );
    await packageRelease(root, output, "v1.2.3");
    expect(await readFile(join(output, "SHA256SUMS"), "utf8")).toBe(first);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
