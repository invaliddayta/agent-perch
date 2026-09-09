/// <reference lib="webworker" />
import { MODEL_FILES, MODEL_PATH, RUNTIME_PATH } from "./speech-model";
import type { Transcriber } from "@moonshine-ai/moonshine-wasm";

type Request =
  | { type: "prepare"; id: number }
  | { type: "transcribe"; id: number; audio: Float32Array }
  | { type: "dispose" };

let loading: Promise<Transcriber> | undefined;
let queue = Promise.resolve();

function load(id: number): Promise<Transcriber> {
  return (loading ??= (async () => {
    if (!self.crossOriginIsolated)
      throw new Error(
        "Local English speech requires cross-origin isolation. Reload the page; check the server's COOP/COEP headers if this persists.",
      );
    // The complete, versioned runtime is self-hosted. Never use the CDN catalog.
    const { Transcriber, ModelArch, AssetDownloader, loadMoonshineModule } =
      (await import(
        /* @vite-ignore */ `${RUNTIME_PATH}/index.js`
      )) as typeof import("@moonshine-ai/moonshine-wasm");
    let timeout: ReturnType<typeof setTimeout>;
    const module = await Promise.race([
      loadMoonshineModule(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "The local speech runtime did not start. Reload and retry; check this browser's WASM support.",
              ),
            ),
          60000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    const total = Object.values(MODEL_FILES).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    const downloader = new AssetDownloader({
      cacheName: "perch-speech-v1",
      onProgress: (loaded) =>
        self.postMessage({
          type: "progress",
          id,
          phase: "loading",
          progress: Math.min(100, (loaded / total) * 100),
        }),
    });
    return Transcriber.loadFromUrls(
      Object.fromEntries(
        Object.keys(MODEL_FILES).map((file) => [file, `${MODEL_PATH}/${file}`]),
      ),
      {
        modelArch: ModelArch.MediumStreaming,
        module,
        downloader,
        options: { identify_speakers: "false" },
      },
    );
  })().catch((error) => {
    loading = undefined;
    throw error;
  }));
}

async function run(request: Exclude<Request, { type: "dispose" }>) {
  const { id } = request;
  try {
    const transcriber = await load(id);
    if (request.type === "prepare") {
      self.postMessage({ type: "ready", id, device: "WASM" });
      return;
    }
    const { audio } = request;
    let energy = 0;
    for (const sample of audio) energy += sample * sample;
    const text =
      !audio.length || Math.sqrt(energy / audio.length) < 0.0001
        ? ""
        : transcriber
            .transcribe(audio, { sampleRate: 16000 })
            .lines.map((line) => line.text.trim())
            .filter(Boolean)
            .join(" ");
    self.postMessage({ type: "transcript", id, text, device: "WASM" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "error",
      id,
      message: /404|fetch|download|imported module/i.test(detail)
        ? `Local English speech assets are unavailable. Run "bun run voice:prepare" and rebuild. (${detail})`
        : detail,
    });
  }
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === "dispose") {
    void loading?.then((transcriber) => transcriber.close()).catch(() => {});
    return;
  }
  // CPU inference is synchronous. The controller terminates this worker to cancel it.
  if (request.type === "prepare") void run(request);
  else
    queue = queue.then(
      () => run(request),
      () => run(request),
    );
});
