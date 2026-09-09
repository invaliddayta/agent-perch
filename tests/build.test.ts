import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";

test("production speech uses external runtime URLs without emitting duplicate WASM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-build-"));
  try {
    const result = await build({
      root: join(import.meta.dir, ".."),
      logLevel: "silent",
      publicDir: false,
      build: { outDir: dir, write: false },
    });
    if ("on" in result) throw new Error("Unexpected watch build");
    const files = (Array.isArray(result) ? result : [result]).flatMap(
      (r) => r.output,
    );
    expect(files.some((f) => f.fileName.endsWith(".wasm"))).toBe(false);
    const worker = files.find((f) => f.fileName.includes("voice.worker-"));
    expect(worker?.type).toBe("asset");
    if (worker?.type !== "asset") throw new Error("Missing speech worker");
    const code =
      typeof worker.source === "string"
        ? worker.source
        : new TextDecoder().decode(worker.source);
    expect(code).toContain("/speech/moonshine-0.1.5");
    expect(code).toContain("moonshine-medium-streaming-en");
    expect(code).not.toContain("huggingface");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
