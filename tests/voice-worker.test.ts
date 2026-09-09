import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { MODEL_FILES, MODEL_PATH } from "../src/speech-model";

let source: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/voice.worker.ts")],
    target: "browser",
    plugins: [
      {
        name: "fixture inference",
        setup(build) {
          build.onLoad({ filter: /voice\.worker\.ts$/ }, async ({ path }) => {
            const code = await Bun.file(path).text();
            expect(code).toContain("`${RUNTIME_PATH}/index.js`");
            return {
              loader: "ts",
              contents: code.replace(
                "`${RUNTIME_PATH}/index.js`",
                '"fixture-runtime"',
              ),
            };
          });
          build.onResolve({ filter: /^fixture-runtime$/ }, () => ({
            path: "runtime",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: `
        export const ModelArch = { MediumStreaming: 5 };
        export const loadMoonshineModule = async () => ({});
        export class AssetDownloader { constructor(options) { this.options = options; } }
        export class Transcriber {
          static async loadFromUrls(files, {downloader, ...options}) {
            postMessage({type: "fixture-load", files, options, cache: downloader.options.cacheName});
            await new Promise(resolve => setTimeout(resolve, 20));
            if (fixture.failLoad) throw Error("Failed to download: 404");
            downloader.options.onProgress(1000000);
            return new Transcriber();
          }
          transcribe(audio, options) {
            postMessage({type: "fixture-inference", options});
            if (audio[0] < 0) throw Error("Inference failed");
            return {lines: [{text: "  Local words.  "}, {text: ""}, {text: "Second sentence."}]};
          }
          close() { postMessage({type: "fixture-disposed"}); }
        }
      `,
          }));
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Worker fixture build failed");
  source = await result.outputs[0].text();
});

function spawn(config: { isolated?: boolean; failLoad?: boolean } = {}) {
  const url = URL.createObjectURL(
    new Blob(
      [
        `globalThis.fixture = ${JSON.stringify(config)};
     globalThis.crossOriginIsolated = fixture.isolated !== false;
     Object.defineProperty(globalThis, "navigator", {value: {language: "de-AT"}});`,
        source,
      ],
      { type: "application/javascript" },
    ),
  );
  const worker = new Worker(url);
  const messages: Record<string, any>[] = [];
  let error: unknown;
  worker.onmessage = (event) => messages.push(event.data);
  worker.onerror = (event) => {
    error = event.message;
  };
  return {
    messages,
    send: (message: object) => worker.postMessage(message),
    async until(predicate: () => unknown) {
      for (let i = 0; i < 300; i++) {
        if (error) throw new Error(String(error));
        if (predicate()) return;
        await Bun.sleep(10);
      }
      throw new Error("Worker fixture timed out");
    },
    async close() {
      await worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

test("English worker shares its model, uses only pinned local URLs, joins lines, skips silence, and disposes", async () => {
  const worker = spawn();
  try {
    worker.send({ type: "prepare", id: 1 });
    worker.send({ type: "prepare", id: 2 });
    worker.send({ type: "transcribe", id: 3, audio: new Float32Array([0.1]) });
    await worker.until(() =>
      worker.messages.some((m) => m.type === "transcript"),
    );
    const loads = worker.messages.filter((m) => m.type === "fixture-load");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      files: Object.fromEntries(
        Object.keys(MODEL_FILES).map((file) => [file, `${MODEL_PATH}/${file}`]),
      ),
      options: { modelArch: 5, options: { identify_speakers: "false" } },
      cache: "perch-speech-v1",
    });
    expect(
      worker.messages.filter((m) => m.type === "ready").map((m) => m.id),
    ).toEqual([1, 2]);
    expect(worker.messages.find((m) => m.type === "transcript")).toMatchObject({
      id: 3,
      text: "Local words. Second sentence.",
      device: "WASM",
    });
    expect(
      worker.messages.find((m) => m.type === "fixture-inference")?.options,
    ).toEqual({ sampleRate: 16000 });
    const progress = worker.messages.find(
      (m) => m.type === "progress",
    )?.progress;
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(100);
    worker.send({ type: "transcribe", id: 4, audio: new Float32Array([0, 0]) });
    await worker.until(() => worker.messages.some((m) => m.id === 4));
    expect(worker.messages.find((m) => m.id === 4)?.text).toBe("");
    expect(
      worker.messages.filter((m) => m.type === "fixture-inference"),
    ).toHaveLength(1);
    worker.send({ type: "dispose" });
    await worker.until(() =>
      worker.messages.some((m) => m.type === "fixture-disposed"),
    );
  } finally {
    await worker.close();
  }
});

for (const scenario of ["isolation", "download", "inference"] as const) {
  test(`English worker reports ${scenario} failure without cloud or smaller-model fallback`, async () => {
    const worker = spawn({
      isolated: scenario !== "isolation",
      failLoad: scenario === "download",
    });
    try {
      worker.send({
        type: "transcribe",
        id: 1,
        audio: new Float32Array([-0.1]),
      });
      await worker.until(() => worker.messages.some((m) => m.type === "error"));
      expect(
        worker.messages.find((m) => m.type === "error")?.message,
      ).toContain(
        scenario === "isolation"
          ? "cross-origin isolation"
          : scenario === "download"
            ? "voice:prepare"
            : "Inference failed",
      );
      expect(
        worker.messages.some((m) =>
          ["transcript", "fallback", "restart-wasm"].includes(m.type),
        ),
      ).toBe(false);
    } finally {
      await worker.close();
    }
  });
}
