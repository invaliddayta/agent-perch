// Open /tests/browser.html on the Vite dev server. No agent or backend is used.
import { createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Terminal, type TerminalHandle } from "../src/Terminal";
import { useSessions } from "../src/sessions";
import type { Session, Snapshot } from "../src/types";
import { App } from "../src/App";
import { decodeRecording } from "../src/voice";
import "../src/style.css";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function wait(predicate: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Browser fixture timed out");
}
async function rejects(action: () => unknown, message: string) {
  try {
    await action();
  } catch (error) {
    assert(
      String(error).includes(message),
      `Expected ${message}, got ${error}`,
    );
    return;
  }
  throw new Error(`Expected rejection: ${message}`);
}

class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  sent: Record<string, any>[] = [];
  onmessage?: (event: MessageEvent) => void;
  onclose?: (event: CloseEvent) => void;
  onerror?: () => void;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  receive(message: object) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = Socket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
  async bracketed(enabled: boolean) {
    this.sent = [];
    this.receive({
      type: "output",
      data: `\x1b[?2004${enabled ? "h" : "l"}\x1b[?2004$p`,
    });
    await wait(() => this.sent.some((m) => m.type === "response"));
  }
}

export async function runBrowserChecks() {
  const originalSocket = window.WebSocket;
  const originalFetch = window.fetch;
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:400px";
  document.body.append(host);
  const root = createRoot(host);
  const checks: string[] = [];
  const ref = createRef<TerminalHandle>();
  const noop = () => {};
  const renderTerminal = (control = true, fontSize = 13, windowId?: string) => {
    flushSync(() =>
      root.render(
        <Terminal
          ref={ref}
          session="$1"
          created={1}
          windowId={windowId}
          control={control}
          fitScreen
          fontSize={fontSize}
          modifiers={{ ctrl: false, alt: false }}
          onModifierUsed={noop}
          onState={noop}
          onPane={noop}
          onClipboard={noop}
        />,
      ),
    );
    return Socket.instances.at(-1)!;
  };
  try {
    for (const rate of [8000, 16000, 44100, 48000]) {
      for (const channels of [1, 2]) {
        const frames = rate / 10;
        const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
        const text = (offset: number, value: string) => {
          for (let i = 0; i < value.length; i++)
            data.setUint8(offset + i, value.charCodeAt(i));
        };
        text(0, "RIFF");
        data.setUint32(4, data.byteLength - 8, true);
        text(8, "WAVEfmt ");
        data.setUint32(16, 16, true);
        data.setUint16(20, 1, true);
        data.setUint16(22, channels, true);
        data.setUint32(24, rate, true);
        data.setUint32(28, rate * channels * 2, true);
        data.setUint16(32, channels * 2, true);
        data.setUint16(34, 16, true);
        text(36, "data");
        data.setUint32(40, data.byteLength - 44, true);
        for (let i = 0; i < frames; i++)
          for (let channel = 0; channel < channels; channel++)
            data.setInt16(
              44 + (i * channels + channel) * 2,
              Math.round(
                Math.sin((2 * Math.PI * 440 * i) / rate) *
                  (channel ? 0.2 : 0.6) *
                  32767,
              ),
              true,
            );
        const audio = await decodeRecording(
          new Blob([data.buffer], { type: "audio/wav" }),
        );
        assert(
          audio.length === 1600,
          `Native ${rate} Hz decoding must return 16 kHz samples`,
        );
        const power =
          audio.reduce((sum, value) => sum + value * value, 0) / audio.length;
        assert(
          Math.abs(power - (channels === 1 ? 0.18 : 0.08)) < 0.01,
          "Native decoding must preserve audio energy and average stereo channels",
        );
      }
    }
    await rejects(() => decodeRecording(new Blob(["invalid audio"])), "");
    checks.push(
      "PASS native 8/16/44.1/48 kHz audio resampling, stereo mixing, and decode failure",
    );
    window.WebSocket = Socket as unknown as typeof WebSocket;
    let ws = renderTerminal();
    await rejects(() => ref.current!.capturePasteTarget(), "connected");
    ws.receive({ type: "ready", paneId: "%1", viewerId: "$20" });
    const target = ref.current!.capturePasteTarget();
    await rejects(() => target.paste("not yet"), "bracketed paste");
    await ws.bracketed(true);
    const delivery = target.paste("first\nsecond");
    const message = ws.sent.find((m) => m.type === "paste")!;
    assert(
      message?.paneId === "%1" &&
        message.opencodeOnly &&
        message.submit === false,
      "Paste must bind its original pane and remain OpenCode-only, without submission",
    );
    assert(
      message.data.startsWith("\x1b[200~") &&
        message.data.endsWith("\x1b[201~"),
      "xterm must supply bracketed paste framing without Enter",
    );
    ws.receive({ type: "input-ack", id: message.id });
    await delivery;
    await rejects(
      () => target.paste("unacknowledged fixture"),
      "not acknowledged",
    );
    assert(
      ws.sent.filter((m) => m.type === "paste").length === 2,
      "Uncertain delivery must never be retried automatically",
    );
    checks.push("PASS guarded, acknowledged, non-submitting paste");

    ws.receive({ type: "pane", paneId: "%2", viewerId: "$20" });
    ws.receive({ type: "pane", paneId: "%1", viewerId: "$20" });
    assert(
      target.signal.aborted,
      "Returning to the original pane must not revive a destination",
    );
    await rejects(() => target.paste("stale"), "terminal changed");
    const cancelled = ref.current!.capturePasteTarget();
    let cancellations = 0;
    cancelled.signal.addEventListener("abort", () => cancellations++);
    ref.current!.cancelPaste();
    ref.current!.cancelPaste();
    assert(cancellations === 1, "Navigation must cancel targeting work once");
    await rejects(() => cancelled.paste("stale"), "terminal changed");
    checks.push(
      "PASS pane round trips and explicit navigation invalidate destinations",
    );

    const resized = ref.current!.capturePasteTarget();
    const count = Socket.instances.length;
    renderTerminal(true, 16);
    assert(
      Socket.instances.length === count && !resized.signal.aborted,
      "Font changes must resize without replacing the attachment",
    );
    ws.close();
    assert(
      resized.signal.aborted,
      "Disconnect must abort targeting work immediately",
    );
    await rejects(() => resized.paste("disconnected"), "terminal changed");
    ws = renderTerminal(true, 16, "@2");
    ws.receive({ type: "ready", paneId: "%1", viewerId: "$21" });
    await ws.bracketed(true);
    await rejects(
      () => resized.paste("new connection, same pane"),
      "terminal changed",
    );
    const unconfirmed = ref
      .current!.capturePasteTarget()
      .paste("uncertain delivery");
    const rejected = rejects(
      () => unconfirmed,
      "before delivery was confirmed",
    );
    flushSync(() => root.render(null));
    await rejected;
    checks.push(
      "PASS font resize, disconnect, reattach, and uncertain delivery cleanup",
    );

    ws = renderTerminal(false);
    ws.receive({ type: "ready", paneId: "%1", viewerId: "$22" });
    assert(!ref.current!.key("x"), "Read-only attachment must reject input");
    await rejects(() => ref.current!.capturePasteTarget(), "connected");
    await ws.bracketed(true);
    assert(
      ws.sent.some((m) => m.type === "response"),
      "Read-only terminals still answer terminal queries",
    );
    flushSync(() => root.render(null));
    checks.push("PASS read-only input boundary and terminal responses");

    type Request = {
      path: string;
      body: unknown;
      reply(value: unknown, status?: number): void;
    };
    const requests: Request[] = [];
    window.fetch = ((path: string, options?: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({
          path,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
          reply: (value, status = 200) =>
            resolve(Response.json(value, { status })),
        });
      })) as typeof fetch;
    let sessions: ReturnType<typeof useSessions>;
    const errors: string[] = [];
    function Sessions() {
      sessions = useSessions((error) => errors.push(error));
      return null;
    }
    const first: Session = {
      id: "$1",
      created: 1,
      name: "first",
      attached: 0,
      panes: [],
    };
    const second: Session = { ...first, id: "$2", name: "second" };
    const snapshot = (items: Session[]): Snapshot => ({
      sessions: items,
      backends: [],
      projectsRoot: "/fixture",
      voiceReady: false,
    });
    flushSync(() => root.render(<Sessions />));
    await wait(() => requests.length === 1);
    const originalPoll = requests.shift()!;
    const creating = sessions!.create({
      backend: "opencode",
      directory: "/fixture",
    });
    requests.shift()!.reply({ id: second.id });
    await wait(() => requests.length === 1);
    const createdPoll = requests.shift()!;
    originalPoll.reply(snapshot([first]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      Boolean(!sessions!.snapshot),
      "Creation must invalidate the preceding snapshot request",
    );
    document.dispatchEvent(new Event("visibilitychange"));
    assert(
      requests.length === 0,
      "Polling must not compete with a mutation refresh",
    );
    createdPoll.reply(snapshot([first, second]));
    assert(
      (await creating).id === second.id,
      "Create must resolve the new session",
    );
    await wait(() => sessions!.snapshot?.sessions.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      sessions!.snapshot?.sessions.length === 2,
      "Older poll must not hide a created session",
    );
    checks.push("PASS creation and polling share ordered snapshot ownership");

    document.dispatchEvent(new Event("visibilitychange"));
    await wait(() => requests.length === 1);
    const beforeKill = requests.shift()!;
    const killing = sessions!.kill(first);
    const mutation = requests.shift()!;
    assert(
      mutation.path === "/api/sessions/kill" &&
        JSON.stringify(mutation.body) ===
          JSON.stringify({ id: first.id, created: first.created }),
      "Kill must retain the complete session identity",
    );
    mutation.reply({ ok: true });
    await killing;
    beforeKill.reply({ error: "obsolete failure" }, 500);
    await wait(() => sessions!.snapshot?.sessions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      !sessions!.offline && errors.length === 0,
      "Old failures must not mark the host offline",
    );
    assert(
      sessions!.snapshot?.sessions[0].id === second.id,
      "Kill must preserve unrelated sessions",
    );

    const failedKill = sessions!.kill(second);
    const failed = rejects(() => failedKill, "denied");
    requests.shift()!.reply({ error: "denied" }, 409);
    await failed;
    assert(
      sessions!.snapshot?.sessions[0].id === second.id,
      "Failed kill must not remove a session",
    );
    checks.push("PASS confirmed kill, stale errors, and failed mutations");

    document.dispatchEvent(new Event("visibilitychange"));
    await wait(() => requests.length === 1);
    requests.shift()!.reply({ error: "host unavailable" }, 503);
    await wait(() => sessions!.offline);
    assert(
      errors.includes("host unavailable"),
      "Current polling failures must be surfaced",
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(() => requests.length === 1);
    requests.shift()!.reply(snapshot([second]));
    await wait(() => !sessions!.offline);
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(() => requests.length === 1);
    const afterUnmount = requests.shift()!;
    flushSync(() => root.render(null));
    afterUnmount.reply({ error: "unmounted" }, 500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      !errors.includes("unmounted"),
      "Unmount must invalidate pending refreshes",
    );
    checks.push("PASS offline recovery and unmount invalidation");
    checks.push(...(await appChecks(root, host)));
    return checks;
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.WebSocket = originalSocket;
    window.fetch = originalFetch;
  }
}

async function appChecks(root: Root, host: HTMLElement) {
  const descriptors = ["Worker", "MediaRecorder", "OfflineAudioContext"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(window, key)] as const,
  );
  const devices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const savedSpeechPreference = localStorage.getItem("perch-auto-speech");
  const workers: SpeechWorker[] = [];
  let stops = 0;
  let microphoneRequests = 0;
  let preparationError: string | undefined;
  class SpeechWorker extends EventTarget {
    messages: Record<string, any>[] = [];
    terminated = false;
    constructor() {
      super();
      workers.push(this);
    }
    postMessage(message: Record<string, any>) {
      this.messages.push(message);
      if (message.type === "prepare")
        queueMicrotask(() =>
          this.reply(
            preparationError
              ? { type: "error", id: message.id, message: preparationError }
              : { type: "ready", id: message.id, device: "WASM" },
          ),
        );
    }
    reply(data: object) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  class Recorder extends EventTarget {
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(
          Object.assign(new Event("dataavailable"), {
            data: new Blob(["fixture audio"]),
          }),
        );
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  const globals = {
    Worker: SpeechWorker,
    MediaRecorder: Recorder,
    OfflineAudioContext: class {
      async decodeAudioData() {
        return {
          length: 160,
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(160).fill(0.1),
        };
      }
    },
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(window, key, { configurable: true, value });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        microphoneRequests++;
        return { getTracks: () => [{ stop: () => stops++ }] };
      },
    },
  });
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim() === label,
    )!;
  const click = (label: string) => {
    const element = button(label);
    assert(element && !element.disabled, `Button unavailable: ${label}`);
    flushSync(() => element.click());
  };
  const open = (name: string) =>
    flushSync(() => {
      const item = Array.from(
        host.querySelectorAll<HTMLButtonElement>(".session-item"),
      ).find((b) => b.textContent?.includes(name));
      assert(item, `Session missing: ${name}`);
      item.click();
    });
  const makeSession = (id: number): Session => ({
    id: `$${id}`,
    created: 1,
    name: `fixture-${id}`,
    attached: 0,
    panes: [
      {
        id: `%${id}`,
        windowId: `@${id}`,
        windowName: "main",
        index: "0",
        command: "opencode",
        cwd: "/fixture",
        active: true,
        windowActive: true,
        dead: false,
      },
    ],
  });
  let list = [makeSession(1), makeSession(2)];
  let voiceReady = true;
  let uploads: { signal: AbortSignal; finish(): void }[] = [];
  let mutations: { path: string; body: any; finish(ok: boolean): void }[] = [];
  window.fetch = ((path: string, options?: RequestInit) => {
    if (path === "/api/sessions" && options?.method === "GET")
      return Promise.resolve(
        Response.json({
          sessions: list,
          projectsRoot: "/fixture",
          voiceReady,
          backends: [
            {
              id: "opencode",
              label: "OpenCode",
              available: true,
              initialPrompt: true,
            },
          ],
        }),
      );
    if (path === "/api/images")
      return new Promise<Response>((resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        uploads.push({
          signal,
          finish: () => resolve(Response.json({ path: "/fixture/image.png" })),
        });
      });
    return new Promise<Response>((resolve) => {
      mutations.push({
        path,
        body: JSON.parse(String(options?.body)),
        finish: (ok) => {
          if (ok)
            list = path.endsWith("kill")
              ? list.filter((s) => s.id !== "$3")
              : [...list, makeSession(3)];
          resolve(
            Response.json(
              ok ? { id: "$3", ok: true } : { error: "fixture refusal" },
              { status: ok ? 200 : 409 },
            ),
          );
        },
      });
    });
  }) as typeof fetch;
  const connect = async (id: number) => {
    const ws = Socket.instances.at(-1)!;
    ws.receive({
      type: "ready",
      paneId: `%${id}`,
      viewerId: `$${20 + Socket.instances.length}`,
    });
    await ws.bracketed(true);
    await wait(
      () =>
        button("Dictate on device") && !button("Dictate on device").disabled,
    );
    return ws;
  };
  const record = async () => {
    click("Dictate on device");
    await wait(() => button("Stop recording"));
    click("Stop recording");
    const worker = workers.at(-1)!;
    await wait(() => worker.messages.some((m) => m.type === "transcribe"));
    const job = worker.messages.find((m) => m.type === "transcribe")!;
    worker.messages = [];
    return (text: string) =>
      worker.reply({ type: "transcript", id: job.id, text, device: "WASM" });
  };
  try {
    localStorage.removeItem("perch-auto-speech");
    flushSync(() => root.render(<App />));
    await wait(() => host.querySelector(".session-item"));
    assert(
      Number(workers.length) === 0 && Number(microphoneRequests) === 0,
      "A first visit must not load speech or open the microphone",
    );
    open("fixture-1");
    let ws = await connect(1);
    click("Switch session");
    open("fixture-1");
    assert(
      !button("Dictate on device").disabled,
      "Reselecting the current session must preserve its live pane",
    );
    const finish = await record();
    assert(
      localStorage.getItem("perch-auto-speech") === "true",
      "First dictation must remember startup preparation",
    );
    finish("dictated fixture");
    await wait(() => ws.sent.some((m) => m.type === "paste"));
    let paste = ws.sent.find((m) => m.type === "paste")!;
    assert(
      paste.data.includes("dictated fixture") && paste.submit === false,
      "Dictation must paste without submitting",
    );
    ws.receive({ type: "input-ack", id: paste.id });
    await wait(() => !host.querySelector(".progress"));
    assert(
      stops === 1 && workers.length === 1,
      "Speech must release the microphone and retain its worker",
    );

    click("Dictate on device");
    await wait(() => button("Stop recording"));
    ws.receive({ type: "pane", paneId: "%2" });
    ws.receive({ type: "pane", paneId: "%1" });
    await wait(() => button("Dictate on device"));
    assert(
      Number(stops) === 2,
      "A pane change must release an active microphone",
    );
    const lateTranscript = await record();
    const old = ws;
    click("Switch session");
    open("fixture-2");
    ws = await connect(2);
    lateTranscript("must never reach the other terminal");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      !ws.sent.some((m) => m.type === "paste") &&
        old.sent.filter((m) => m.type === "paste").length === 1,
      "Session changes must discard late transcripts instead of retargeting them",
    );
    assert(
      workers[0].terminated,
      "Cancelling synchronous inference must terminate its worker",
    );

    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File(["image fixture"], "fixture.png", { type: "image/png" }),
    );
    host.querySelector(".workspace")!.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        clipboardData: clipboard,
      }),
    );
    await wait(() => uploads.length === 1);
    click("Switch session");
    open("fixture-1");
    ws = await connect(1);
    assert(
      uploads[0].signal.aborted,
      "Navigation must abort an image upload's destination",
    );
    uploads[0].finish();
    await wait(() => !host.querySelector(".progress"));
    uploads = [];
    host.querySelector(".workspace")!.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        clipboardData: clipboard,
      }),
    );
    await wait(() => uploads.length === 1);
    uploads[0].finish();
    await wait(() => ws.sent.some((m) => m.type === "paste"));
    paste = ws.sent.find((m) => m.type === "paste")!;
    assert(
      paste.data.includes("/fixture/image.png") && paste.submit === false,
      "Image paths must use guarded non-submitting delivery",
    );
    ws.receive({ type: "input-ack", id: paste.id });
    await wait(() => !host.querySelector(".progress"));

    const failure = await record();
    failure("recover these words");
    await wait(() => ws.sent.filter((m) => m.type === "paste").length === 2);
    paste = ws.sent.filter((m) => m.type === "paste").at(-1)!;
    ws.receive({
      type: "input-ack",
      id: paste.id,
      error: "fixture delivery failed",
    });
    await wait(() => host.querySelector(".recovery"));
    click("Switch session");
    open("fixture-2");
    await connect(2);
    assert(
      host
        .querySelector(".recovery")
        ?.textContent?.includes("recover these words"),
      "Uncertain dictation must remain recoverable after leaving its attachment",
    );

    click("Switch session");
    click("New session");
    const form = host.querySelector("form")!;
    (form.elements.namedItem("directory") as HTMLInputElement).value =
      "/fixture/new";
    flushSync(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert(
      mutations.length === 1,
      "Repeated submit must create only one session",
    );
    const dialog = host.querySelector("dialog")!;
    flushSync(() =>
      dialog.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    assert(dialog.open, "Busy creation must not dismiss its dialog");
    assert(
      mutations[0].body.directory === "/fixture/new",
      "Creation must preserve the requested directory",
    );
    mutations[0].finish(true);
    await wait(
      () => host.querySelector(".session-name")?.textContent === "fixture-3",
    );
    await connect(3);
    mutations = [];
    click("Switch session");
    click("Kill session fixture-3");
    assert(
      document.activeElement?.textContent === "Cancel",
      "Kill must initially focus Cancel",
    );
    click("Kill session");
    assert(mutations.length === 1, "Kill must issue one mutation");
    mutations[0].finish(false);
    await wait(() =>
      host
        .querySelector(".form-error")
        ?.textContent?.includes("fixture refusal"),
    );
    click("Kill session");
    mutations[1].finish(true);
    await wait(() => !host.querySelector(".session-name"));
    assert(
      host.textContent?.includes("fixture-1") &&
        host.textContent.includes("fixture-2"),
      "Confirmed kill must return to the manager and preserve other sessions",
    );

    flushSync(() => root.render(null));
    assert(workers.at(-1)!.terminated, "Unmount must release the warm model");
    const beforeStartup = workers.length;
    const beforeMicrophone = microphoneRequests;
    voiceReady = false;
    flushSync(() =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    );
    await wait(() => host.querySelector(".session-item"));
    assert(
      workers.length === beforeStartup,
      "Remembered preparation must wait for available host assets",
    );
    voiceReady = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(() => workers.length > beforeStartup);
    click("Settings");
    await wait(() => host.textContent?.includes("On-device speech is ready."));
    assert(
      workers.length === beforeStartup + 1 &&
        microphoneRequests === beforeMicrophone,
      "Returning visits must prepare exactly once without microphone access",
    );
    const speechToggle = () =>
      Array.from(host.querySelectorAll("label"))
        .find((label) =>
          label.textContent?.includes("Prepare speech on startup"),
        )!
        .querySelector<HTMLInputElement>("input")!;
    assert(
      speechToggle().checked,
      "Settings must display the saved preference",
    );
    flushSync(() => speechToggle().click());
    click("Prepare speech");
    assert(
      localStorage.getItem("perch-auto-speech") === "false" &&
        !workers.at(-1)!.terminated,
      "Manual preparation must respect opt-out and retain the current warm model",
    );
    flushSync(() =>
      host
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    open("fixture-1");
    ws = await connect(1);
    const warmed = await record();
    warmed("prepared before attachment");
    await wait(() => ws.sent.some((m) => m.type === "paste"));
    paste = ws.sent.find((m) => m.type === "paste")!;
    ws.receive({ type: "input-ack", id: paste.id });
    await wait(() => !host.querySelector(".progress"));
    assert(
      paste.data.includes("prepared before attachment") &&
        paste.submit === false &&
        workers.length === beforeStartup + 1 &&
        localStorage.getItem("perch-auto-speech") === "false",
      "Autoloaded speech must use the current guarded destination without overriding opt-out",
    );

    flushSync(() => root.render(null));
    flushSync(() => root.render(<App />));
    await wait(() => host.querySelector(".session-item"));
    assert(
      workers.length === beforeStartup + 1,
      "Opt-out must prevent startup loading on subsequent visits",
    );
    click("Settings");
    flushSync(() => speechToggle().click());
    await wait(() => host.textContent?.includes("On-device speech is ready."));
    assert(
      localStorage.getItem("perch-auto-speech") === "true" &&
        workers.length === beforeStartup + 2,
      "Explicitly enabling startup preparation must also prepare now",
    );

    flushSync(() => root.render(null));
    preparationError = "fixture speech unavailable";
    flushSync(() => root.render(<App />));
    await wait(() => host.querySelector(".session-item"));
    click("Settings");
    await wait(() => host.textContent?.includes(preparationError!));
    const failedWorkerCount = workers.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      workers.length === failedWorkerCount && workers.at(-1)!.terminated,
      "Failed background loading must release its worker and not retry on polling",
    );
    preparationError = undefined;
    click("Prepare speech");
    await wait(() => host.textContent?.includes("On-device speech is ready."));
    assert(
      workers.length === failedWorkerCount + 1 &&
        microphoneRequests === beforeMicrophone + 1,
      "Manual retry must recover without opening a microphone",
    );
    return [
      "PASS dictation, microphone cancellation, warm model reuse, and late transcripts",
      "PASS image upload cancellation, guarded delivery, and persistent dictation recovery",
      "PASS duplicate submission, busy dialog cancellation, creation, failed kill, and confirmed kill",
      "PASS remembered speech startup, asset gating, opt-out, warm delivery, and failure recovery",
    ];
  } finally {
    flushSync(() => root.render(null));
    if (savedSpeechPreference === null)
      localStorage.removeItem("perch-auto-speech");
    else localStorage.setItem("perch-auto-speech", savedSpeechPreference);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    if (devices) Object.defineProperty(navigator, "mediaDevices", devices);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  }
}
