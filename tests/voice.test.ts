import { expect, test } from "bun:test";
import { createVoice, type VoiceState } from "../src/voice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

test("shares a pending microphone request and releases it when cancelled", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const originalRecorder = Object.getOwnPropertyDescriptor(
    globalThis,
    "MediaRecorder",
  );
  const permissions = [deferred<MediaStream>(), deferred<MediaStream>()];
  let permissionCalls = 0;

  class FakeWorker extends EventTarget {
    postMessage(message: { type: string; id?: number }) {
      if (message.type === "prepare") {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "ready", id: message.id, device: "WASM" },
            }),
          ),
        );
      }
    }
    terminate() {}
  }

  class FakeRecorder extends EventTarget {
    state: RecordingState = "inactive";
    mimeType = "audio/webm";
    constructor(readonly stream: MediaStream) {
      super();
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }

  const tracks = [
    {
      stopCalls: 0,
      stop() {
        this.stopCalls++;
      },
    },
    {
      stopCalls: 0,
      stop() {
        this.stopCalls++;
      },
    },
  ];
  const streams = tracks.map(
    (track) => ({ getTracks: () => [track] }) as unknown as MediaStream,
  );

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => permissions[permissionCalls++].promise,
      },
    },
  });
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeRecorder,
  });

  try {
    const voice = createVoice(
      () => undefined,
      () => undefined,
    );
    const first = voice.start();
    const duplicate = voice.start();
    expect(duplicate).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(permissionCalls).toBe(1);

    const cancelled = first.catch((error: unknown) => error);
    voice.cancel();
    expect(voice.start()).toBe(first);
    permissions[0].resolve(streams[0]);
    expect(await cancelled).toBeInstanceOf(Error);
    expect(tracks[0].stopCalls).toBe(1);

    await Promise.resolve();
    const next = voice.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(permissionCalls).toBe(2);
    permissions[1].resolve(streams[1]);
    await next;
    expect(tracks[1].stopCalls).toBe(0);
    voice.cancel();
    expect(tracks[1].stopCalls).toBe(1);
    voice.dispose();
  } finally {
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: Navigator }).navigator;
    if (originalWorker)
      Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete (globalThis as { Worker?: typeof Worker }).Worker;
    if (originalRecorder)
      Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
    else
      delete (globalThis as { MediaRecorder?: typeof MediaRecorder })
        .MediaRecorder;
  }
});

test("cancelled preparation terminates its worker and can be retried", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers: FakeWorker[] = [];

  class FakeWorker extends EventTarget {
    messages: Array<Record<string, unknown>> = [];
    terminated = false;

    constructor() {
      super();
      workers.push(this);
    }

    postMessage(message: Record<string, unknown>) {
      this.messages.push(message);
      if (message.type !== "prepare" || workers.length === 1) return;
      const data = { type: "ready", id: message.id, device: "WASM" };
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data })),
      );
    }

    terminate() {
      this.terminated = true;
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });

  try {
    const texts: string[] = [];
    const voice = createVoice(
      () => undefined,
      (text) => texts.push(text),
    );
    const preparing = voice.prepare().catch((error) => error);
    voice.cancel();
    expect(await preparing).toBeInstanceOf(Error);
    workers[0].dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "transcript",
          id: 0,
          text: "stale",
          device: "WASM",
        },
      }),
    );
    await voice.prepare();
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].messages[0].type).toBe("prepare");
    expect(texts).toEqual([]);
    voice.dispose();
  } finally {
    if (originalWorker)
      Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete (globalThis as { Worker?: typeof Worker }).Worker;
  }
});

for (const scenario of [
  "ready during recording",
  "stop before ready",
  "cancel",
  "load error",
  "worker error",
  "transcription error",
  "cancel during inference",
] as const) {
  test(`microphone overlaps model loading: ${scenario}`, async () => {
    const keys = ["Worker", "navigator", "MediaRecorder", "window"] as const;
    const originals = keys.map((key) =>
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
    const workers: FakeWorker[] = [];
    let permissionCalls = 0;
    let trackStops = 0;
    const states: VoiceState[] = [];
    const texts: string[] = [];
    class FakeWorker extends EventTarget {
      messages: Array<Record<string, any>> = [];
      terminated = false;
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(message: Record<string, any>) {
        this.messages.push(message);
        if (
          message.type === "transcribe" &&
          scenario !== "cancel during inference"
        )
          queueMicrotask(() => {
            if (scenario === "transcription error") {
              this.reply({
                type: "error",
                id: message.id,
                message: "Inference failed",
              });
            } else
              this.reply({
                type: "transcript",
                id: message.id,
                text: "local words",
                device: "WASM",
              });
          });
      }
      reply(data: Record<string, unknown>) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
      terminate() {
        this.terminated = true;
      }
    }
    class FakeRecorder extends EventTarget {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          const event = new Event("dataavailable");
          Object.assign(event, { data: new Blob(["audio"]) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        });
      }
    }
    const globals = {
      Worker: FakeWorker,
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            permissionCalls++;
            return { getTracks: () => [{ stop: () => trackStops++ }] };
          },
        },
      },
      MediaRecorder: FakeRecorder,
      window: {
        OfflineAudioContext: class {
          constructor(channels: number, length: number, sampleRate: number) {
            expect([channels, length, sampleRate]).toEqual([1, 1, 16000]);
          }
          async decodeAudioData() {
            return {
              length: 160,
              sampleRate: 16000,
              numberOfChannels: 1,
              getChannelData: () => new Float32Array(160).fill(0.1),
            };
          }
        },
      },
    };
    for (const key of keys)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: globals[key],
      });
    const voice = createVoice(
      (state) => states.push(state),
      (text) => texts.push(text),
    );
    try {
      const preparation = voice.prepare();
      const preparationResult = preparation.catch((error) => error);
      expect(permissionCalls).toBe(0);
      expect(voice.prepare()).toBe(preparation);
      await voice.start();
      expect(permissionCalls).toBe(1);
      expect(states.at(-1)?.phase).toBe("recording");
      let worker = workers[0];
      const id = worker.messages[0].id;
      worker.reply({ type: "progress", id, phase: "loading", progress: 25 });
      expect(states.at(-1)?.phase).toBe("recording");
      if (scenario === "load error" || scenario === "worker error") {
        if (scenario === "load error")
          worker.reply({ type: "error", id, message: "Model unavailable" });
        else
          worker.dispatchEvent(
            Object.assign(new Event("error"), { message: "Model unavailable" }),
          );
        expect((await preparationResult).message).toBe("Model unavailable");
        expect(trackStops).toBe(1);
        expect(states.at(-1)?.phase).toBe("error");
        expect(texts).toEqual([]);
        return;
      }
      if (scenario === "ready during recording") {
        worker.reply({ type: "ready", id, device: "WASM" });
        await preparation;
        expect(states.at(-1)?.phase).toBe("recording");
      }
      const stopping = voice.stop();
      const stopResult = stopping.catch((error) => error);
      await Bun.sleep(0);
      expect(trackStops).toBe(1);
      if (scenario === "cancel") {
        voice.cancel();
        worker.reply({ type: "ready", id, device: "WASM" });
        expect(await preparationResult).toBeInstanceOf(Error);
        expect(await stopResult).toBeInstanceOf(Error);
        expect(texts).toEqual([]);
        expect(
          worker.messages.some((message) => message.type === "transcribe"),
        ).toBe(false);
        return;
      }
      if (scenario !== "ready during recording") {
        expect(states.at(-1)?.phase).toBe("transcribing");
        expect(
          worker.messages.some((message) => message.type === "transcribe"),
        ).toBe(false);
        worker.reply({ type: "ready", id, device: "WASM" });
      }
      if (scenario === "transcription error") {
        expect((await stopResult).message).toBe("Inference failed");
        expect(states.at(-1)?.phase).toBe("error");
        expect(texts).toEqual([]);
        expect(worker.terminated).toBe(true);
        return;
      }
      if (scenario === "cancel during inference") {
        for (
          let i = 0;
          i < 50 && !worker.messages.some((m) => m.type === "transcribe");
          i++
        )
          await Bun.sleep(1);
        const request = worker.messages.find((m) => m.type === "transcribe");
        expect(request).toBeDefined();
        voice.cancel();
        expect(await stopResult).toBeInstanceOf(Error);
        expect(worker.terminated).toBe(true);
        worker.reply({
          type: "transcript",
          id: request!.id,
          text: "stale",
          device: "WASM",
        });
        expect(texts).toEqual([]);
        const retry = voice.prepare();
        const fresh = workers[1];
        fresh.reply({
          type: "ready",
          id: fresh.messages[0].id,
          device: "WASM",
        });
        await retry;
        return;
      }
      await stopping;
      expect(texts).toEqual(["local words"]);
      expect(states.at(-1)?.phase).toBe("ready");
      await voice.prepare();
      expect(
        worker.messages.filter((message) => message.type === "prepare"),
      ).toHaveLength(1);
      await voice.start();
      expect(workers.at(-1)).toBe(worker);
      voice.cancel();
    } finally {
      voice.dispose();
      keys.forEach((key, i) => {
        if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });
}
