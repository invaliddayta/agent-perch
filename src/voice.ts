export type VoiceState = {
  phase:
    "unloaded" | "loading" | "ready" | "recording" | "transcribing" | "error";
  message: string;
  progress?: number;
  device?: string;
};

export type Voice = {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  dispose(): void;
};

type WorkerMessage =
  | {
      type: "progress";
      id: number;
      phase: "loading" | "transcribing";
      progress: number;
    }
  | { type: "ready"; id: number; device: string }
  | { type: "transcript"; id: number; text: string; device: string }
  | { type: "error"; id: number; message: string };

type Capture = {
  id: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  timeout?: ReturnType<typeof setTimeout>;
};

function pending(id: number) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { id, promise, resolve, reject };
}

const MAX_RECORDING_MS = 60_000;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function decodeRecording(blob: Blob): Promise<Float32Array> {
  const Context =
    window.OfflineAudioContext ??
    (
      window as typeof window & {
        webkitOfflineAudioContext?: typeof OfflineAudioContext;
      }
    ).webkitOfflineAudioContext;
  if (!Context) throw new Error("This browser cannot decode recorded audio.");
  // Decoding resamples natively, without opening an audio output device.
  const context = new Context(1, 1, 16_000);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++)
      mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

export function createVoice(
  onState: (state: VoiceState) => void,
  onText: (text: string) => void,
): Voice {
  let worker: Worker | undefined;
  let nextId = 0;
  let activeId = 0;
  let prepared = false;
  let device: string | undefined;
  let phase: VoiceState["phase"] = "unloaded";
  let disposed = false;
  let capture: Capture | undefined;
  let startPending: Promise<void> | undefined;
  let preparePending: ReturnType<typeof pending> | undefined;
  let transcriptionPending: ReturnType<typeof pending> | undefined;

  const emit = (state: VoiceState): void => {
    phase = state.phase;
    if (!disposed) onState(state);
  };

  const releaseCapture = (target = capture): void => {
    if (!target) return;
    if (target.timeout) clearTimeout(target.timeout);
    target.timeout = undefined;
    target.stream.getTracks().forEach((track) => track.stop());
    if (capture === target) capture = undefined;
  };

  const fail = (error: Error): void => {
    cancel(error);
    prepared = false;
    worker?.terminate();
    worker = undefined;
    emit({ phase: "error", message: error.message, device });
  };

  const loadingUpdate = (message: string, progress?: number): void => {
    emit({
      phase:
        phase === "recording" || phase === "transcribing" ? phase : "loading",
      message:
        phase === "recording"
          ? `Listening (60 second maximum); ${message}`
          : message,
      progress,
      device,
    });
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const instance = new Worker(new URL("./voice.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = instance;
    instance.addEventListener(
      "message",
      (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (
          disposed ||
          instance !== worker ||
          (message.id !== activeId && message.id !== preparePending?.id)
        )
          return;
        if (message.type === "progress") {
          loadingUpdate(
            message.phase === "loading"
              ? "Loading speech model on this device..."
              : "Loading the WASM speech engine...",
            message.progress,
          );
        } else if (message.type === "ready") {
          prepared = true;
          device = message.device;
          emit({
            phase:
              phase === "recording" || phase === "transcribing"
                ? phase
                : "ready",
            message:
              phase === "recording"
                ? "Listening (60 second maximum)..."
                : phase === "transcribing"
                  ? "Transcribing locally on this device..."
                  : "On-device speech is ready.",
            device,
          });
          if (preparePending?.id === message.id) {
            preparePending.resolve();
            preparePending = undefined;
          }
        } else if (message.type === "transcript") {
          device = message.device;
          if (message.text) onText(message.text);
          emit({
            phase: "ready",
            message: message.text
              ? "Transcription complete."
              : "No speech detected.",
            device,
          });
          if (transcriptionPending?.id === message.id) {
            transcriptionPending.resolve();
            transcriptionPending = undefined;
          }
        } else {
          fail(new Error(message.message));
        }
      },
    );
    instance.addEventListener("error", (event) => {
      if (disposed || instance !== worker) return;
      fail(new Error(event.message || "Speech worker failed to start."));
    });
    return worker;
  };

  const prepare = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Voice has been disposed."));
    if (prepared) return Promise.resolve();
    if (preparePending) return preparePending.promise;
    const id = ++nextId;
    emit({
      phase: "loading",
      message: "Loading the local speech model...",
      progress: 0,
    });
    preparePending = pending(id);
    const { promise } = preparePending;
    try {
      ensureWorker().postMessage({ type: "prepare", id });
    } catch (error) {
      fail(new Error(reason(error)));
    }
    return promise;
  };

  const stop = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Voice has been disposed."));
    const current = capture;
    if (!current || current.recorder.state === "inactive")
      return transcriptionPending?.promise ?? Promise.resolve();

    transcriptionPending = pending(current.id);
    const { promise } = transcriptionPending;
    current.recorder.stop();
    releaseCapture(current);
    return promise;
  };

  const start = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Voice has been disposed."));
    if (capture?.recorder.state === "recording") return Promise.resolve();
    if (startPending) return startPending;
    if (transcriptionPending)
      return Promise.reject(
        new Error("Wait for the current transcription to finish."),
      );

    const id = ++nextId;
    activeId = id;
    const operation = (async () => {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        const error = new Error(
          "Audio recording is not supported by this browser or requires HTTPS.",
        );
        emit({ phase: "error", message: error.message, device });
        throw error;
      }

      // Model initialization and microphone permission/capture run independently.
      // Keep the rejection handled even if the recording is cancelled before stop.
      const preparation = prepare();
      void preparation.catch(() => undefined);
      if (disposed || activeId !== id)
        throw new Error("Voice operation cancelled.");
      let acquiredStream: MediaStream | undefined;
      let current: Capture | undefined;
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (disposed || activeId !== id) {
          acquiredStream.getTracks().forEach((track) => track.stop());
          acquiredStream = undefined;
          throw new Error("Voice operation cancelled.");
        }

        const localRecorder = new MediaRecorder(acquiredStream);
        current = {
          id,
          stream: acquiredStream,
          recorder: localRecorder,
          chunks: [],
        };
        capture = current;
        localRecorder.addEventListener("dataavailable", (event) => {
          if (event.data.size) current!.chunks.push(event.data);
        });
        localRecorder.addEventListener("error", (event) => {
          const error = new Error(
            event.error?.message || "Audio recording failed.",
          );
          releaseCapture(current);
          if (disposed || activeId !== id) return;
          emit({ phase: "error", message: error.message, device });
          if (transcriptionPending?.id === id) {
            transcriptionPending.reject(error);
            transcriptionPending = undefined;
          }
        });
        localRecorder.addEventListener(
          "stop",
          () => {
            const blob = new Blob(current!.chunks, {
              type:
                localRecorder.mimeType ||
                current!.chunks[0]?.type ||
                "audio/webm",
            });
            current!.chunks = [];
            if (disposed || activeId !== id) return;
            emit({
              phase: "transcribing",
              message: prepared
                ? "Transcribing locally on this device..."
                : "Recording saved in memory; waiting for the speech model...",
              device,
            });
            void Promise.all([decodeRecording(blob), preparation])
              .then(([audio]) => {
                if (disposed || activeId !== id) return;
                if (!audio.length) throw new Error("The recording was empty.");
                ensureWorker().postMessage({ type: "transcribe", id, audio }, [
                  audio.buffer,
                ]);
              })
              .catch((error: unknown) => {
                if (disposed || activeId !== id) return;
                const failure = new Error(
                  `Could not transcribe the recording: ${reason(error)}`,
                );
                emit({ phase: "error", message: failure.message, device });
                if (transcriptionPending?.id === id) {
                  transcriptionPending.reject(failure);
                  transcriptionPending = undefined;
                }
              });
          },
          { once: true },
        );
        localRecorder.start(1_000);
        current.timeout = setTimeout(() => {
          if (capture === current) void stop().catch(() => undefined);
        }, MAX_RECORDING_MS);
        emit({
          phase: "recording",
          message: prepared
            ? "Listening (60 second maximum)..."
            : "Listening (60 second maximum); speech model is loading...",
          device,
        });
      } catch (error) {
        if (current) releaseCapture(current);
        else acquiredStream?.getTracks().forEach((track) => track.stop());
        if (disposed || activeId !== id)
          throw new Error("Voice operation cancelled.");
        const failure = new Error(
          `Could not start the microphone: ${reason(error)}`,
        );
        emit({ phase: "error", message: failure.message, device });
        throw failure;
      }
    })();
    startPending = operation;
    const clear = (): void => {
      if (startPending === operation) startPending = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  };

  const cancel = (error = new Error("Voice operation cancelled.")): void => {
    if (disposed) return;
    const cancelledId = activeId;
    activeId = ++nextId;
    const current = capture;
    if (current?.recorder.state !== "inactive") current?.recorder.stop();
    releaseCapture(current);
    if (current) current.chunks = [];
    if (preparePending || phase === "transcribing") {
      preparePending?.reject(error);
      // Synchronous WASM cannot receive cancellation until inference returns.
      worker?.terminate();
      worker = undefined;
      prepared = false;
    }
    if (transcriptionPending?.id === cancelledId)
      transcriptionPending.reject(error);
    preparePending = undefined;
    transcriptionPending = undefined;
    emit({
      phase: prepared ? "ready" : "unloaded",
      message: prepared ? "On-device speech is ready." : "Voice is not loaded.",
      device,
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    cancel();
    disposed = true;
    worker?.postMessage({ type: "dispose" });
    worker?.terminate();
    worker = undefined;
  };

  emit({ phase: "unloaded", message: "Voice is not loaded." });
  return { prepare, start, stop, cancel, dispose };
}
