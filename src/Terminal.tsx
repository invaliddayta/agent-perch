import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { isTerminalResponse } from "./terminal-protocol";

export type PasteTarget = {
  signal: AbortSignal;
  ready: Promise<void>;
  paste(text: string): Promise<void>;
};
export type TerminalHandle = {
  key(data: string): boolean;
  capturePasteTarget(backend?: "opencode" | "pi" | "terminal"): PasteTarget;
  cancelPaste(): void;
  focus(): void;
  copy(): Promise<void>;
  visibleText(): string;
  search(text: string): void;
  bottom(): void;
};
export function Terminal(props: {
  session: string;
  created: number;
  windowId?: string;
  control: boolean;
  fitScreen: boolean;
  fontSize: number;
  modifiers: { ctrl: boolean; alt: boolean };
  onModifierUsed(): void;
  onState(state: string): void;
  onPane(paneId: string): void;
  onClipboard(text: string, automatic: boolean): void;
  ref: Ref<TerminalHandle>;
}) {
  const { session, created, windowId, control, fitScreen, fontSize, ref } =
    props;
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const fitterRef = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const lastInput = useRef(0);
  const visiblePane = useRef<string | undefined>(undefined);
  const pasteLifetime = useRef<AbortController | null>(null);
  const ready = useRef(false);
  const pasteCapture = useRef<string | null>(null);
  const pending = useRef(new Map<string, (error?: string) => void>());
  const pendingCaptures = useRef(new Map<string, (error?: string) => void>());
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState("connecting");
  function cancelPaste() {
    pasteLifetime.current?.abort();
    pasteLifetime.current = null;
  }
  function fit() {
    const terminal = term.current;
    const size = fitterRef.current?.proposeDimensions();
    if (!terminal || !size) return;
    terminal.resize(
      Math.max(20, Math.min(300, size.cols)),
      Math.max(5, Math.min(120, size.rows)),
    );
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
  }
  function send(data: string) {
    if (
      !latest.current.control ||
      !ready.current ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return false;
    socket.current.send(JSON.stringify({ type: "input", data }));
    lastInput.current = Date.now();
    return true;
  }
  useImperativeHandle(ref, () => ({
    key: send,
    cancelPaste,
    capturePasteTarget(backend = "opencode") {
      const ws = socket.current;
      const paneId = visiblePane.current;
      if (
        !latest.current.control ||
        !ready.current ||
        !paneId ||
        ws?.readyState !== WebSocket.OPEN
      )
        throw new Error("Open a connected terminal before pasting.");
      const { signal } = (pasteLifetime.current ??= new AbortController());
      const targetId = backend === "pi" ? crypto.randomUUID() : undefined;
      const captured = targetId
        ? new Promise<void>((resolve, reject) => {
            const abort = () =>
              finish("The terminal changed. Text was not pasted.");
            const finish = (error?: string) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              pendingCaptures.current.delete(targetId);
              if (error) reject(new Error(error));
              else if (
                signal.aborted ||
                socket.current !== ws ||
                visiblePane.current !== paneId
              )
                reject(new Error("The terminal changed. Text was not pasted."));
              else resolve();
            };
            const timer = setTimeout(
              () =>
                finish(
                  "Paste destination was not acknowledged. Nothing was pasted.",
                ),
              10000,
            );
            pendingCaptures.current.set(targetId, finish);
            signal.addEventListener("abort", abort, { once: true });
            ws.send(
              JSON.stringify({
                type: "capture-paste-target",
                id: targetId,
                paneId,
                backend,
              }),
            );
          })
        : Promise.resolve();
      // A caller may cancel before awaiting readiness; cancellation must not leak a rejection.
      void captured.catch(() => {});
      return {
        signal,
        ready: captured,
        async paste(text) {
          if (backend === "pi") await captured;
          const terminal = term.current;
          if (
            !terminal ||
            signal.aborted ||
            socket.current !== ws ||
            visiblePane.current !== paneId ||
            ws.readyState !== WebSocket.OPEN
          )
            throw new Error("The terminal changed. Text was not pasted.");
          if (
            backend === "terminal" &&
            /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)
          )
            throw new Error(
              "Text contains unsupported terminal control characters.",
            );
          if (
            !terminal.modes.bracketedPasteMode &&
            (backend !== "terminal" || /[\r\n\t]/.test(text))
          )
            throw new Error(
              "The pane is not accepting bracketed paste. Exit tmux copy mode and return to a prompt before trying again.",
            );
          pasteCapture.current = "";
          let data: string;
          try {
            terminal.paste(text);
            data = pasteCapture.current;
          } finally {
            pasteCapture.current = null;
          }
          if (!data) throw new Error("No text was pasted.");
          if (data.length > 64000)
            throw new Error(
              "Paste is too large. Send less than 64,000 characters at a time.",
            );
          const id = crypto.randomUUID();
          return new Promise<void>((resolve, reject) => {
            const abort = () =>
              finish(
                "The terminal changed before delivery was confirmed. Check delivery before resending.",
              );
            const finish = (error?: string) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              pending.current.delete(id);
              if (error) reject(new Error(error));
              else resolve();
            };
            const timer = setTimeout(() => {
              finish(
                "Terminal delivery was not acknowledged. Check the terminal before resending.",
              );
            }, 10000);
            pending.current.set(id, finish);
            if (backend !== "opencode")
              signal.addEventListener("abort", abort, { once: true });
            ws.send(
              JSON.stringify({
                type: "paste",
                data,
                submit: false,
                id,
                paneId,
                opencodeOnly: backend === "opencode",
                backend: backend === "terminal" ? undefined : backend,
                targetId,
              }),
            );
          });
        },
      };
    },
    focus: () => term.current?.focus(),
    copy: async () => {
      const text = term.current?.getSelection();
      if (text) await navigator.clipboard.writeText(text);
    },
    visibleText: () => {
      const terminal = term.current;
      if (!terminal) return "";
      const buffer = terminal.buffer.active;
      const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
      let text = "";
      // Read the displayed buffer, including tmux's alternate-screen copy mode,
      // without changing xterm's selection or asking the host for hidden history.
      for (let row = buffer.viewportY; row < end; row++) {
        const line = buffer.getLine(row)!;
        if (row > buffer.viewportY && !line.isWrapped) text += "\n";
        const continued = row + 1 < end && buffer.getLine(row + 1)!.isWrapped;
        text += line.translateToString(!continued, 0, terminal.cols);
      }
      return text.replace(/\n+$/, "");
    },
    search: (text) => {
      if (text) search.current?.findNext(text);
      else search.current?.clearDecorations();
    },
    bottom: () => term.current?.scrollToBottom(),
  }));
  useEffect(() => {
    const terminal = new Xterm({
      fontFamily: '"DejaVu Sans Mono", "SFMono-Regular", Consolas, monospace',
      fontSize,
      macOptionIsMeta: true,
      cursorBlink: control,
      scrollback: 6000,
      allowProposedApi: false,
      convertEol: false,
      theme: {
        background: "#080b12",
        foreground: "#dededb",
        cursor: "#ffcc00",
        selectionBackground: "#514629",
        black: "#1b1d21",
        red: "#e99186",
        green: "#b5d994",
        yellow: "#e4c58a",
        blue: "#91b4d2",
        magenta: "#c7a3ca",
        cyan: "#8bbfb5",
        white: "#dededb",
        brightBlack: "#858993",
      },
    });
    const fitter = new FitAddon();
    const finder = new SearchAddon();
    terminal.loadAddon(fitter);
    terminal.loadAddon(finder);
    terminal.open(host.current!);
    terminal.attachCustomKeyEventHandler((event) => {
      // Let the browser deliver clipboard files/text instead of sending Ctrl+V to the host.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.code === "KeyV"
      )
        return false;
      return true;
    });
    term.current = terminal;
    search.current = finder;
    fitterRef.current = fitter;
    fit();
    const url = new URL("/terminal", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    Object.entries({
      session,
      created: String(created),
      control: control ? "1" : "0",
      fit: fitScreen ? "1" : "0",
      cols: String(terminal.cols),
      rows: String(terminal.rows),
      ...(windowId ? { window: windowId } : {}),
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const ws = new WebSocket(url);
    socket.current = ws;
    ready.current = false;
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    function status(s: string) {
      if (!disposed) {
        setState(s);
        latest.current.onState(s);
      }
    }
    status("connecting");
    ws.onmessage = (event) => {
      if (disposed) return;
      const msg = JSON.parse(event.data);
      if (
        msg.type === "clipboard" &&
        msg.paneId === visiblePane.current &&
        typeof msg.text === "string" &&
        msg.text.length <= 128 * 1024
      ) {
        latest.current.onClipboard(
          msg.text,
          document.hasFocus() &&
            !document.hidden &&
            Date.now() - lastInput.current < 10000,
        );
      }
      if (msg.type === "output") terminal.write(msg.data);
      if (msg.type === "ready") {
        ready.current = true;
        status("connected");
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
      if (msg.type === "pane" || msg.type === "ready") {
        if (typeof msg.paneId === "string") {
          if (visiblePane.current !== msg.paneId) cancelPaste();
          visiblePane.current = msg.paneId;
          latest.current.onPane(msg.paneId);
        }
      }
      if (msg.type === "paste-target-ack") {
        pendingCaptures.current.get(msg.id)?.(msg.error);
      }
      if (msg.type === "input-ack") {
        pending.current.get(msg.id)?.(msg.error);
      }
      if (msg.type === "error") {
        terminal.writeln(`\r\n${msg.message}`);
        status("error");
      }
    };
    ws.onclose = (event) => {
      if (disposed) return;
      ready.current = false;
      cancelPaste();
      status(event.code === 1000 ? "detached" : "reconnecting");
      if (event.code !== 1000)
        reconnect = setTimeout(() => setAttempt((n) => n + 1), 3000);
    };
    ws.onerror = () => status("disconnected");
    let touchScrolling = false;
    // Gate user input in send(), not xterm: read-only views must still answer terminal queries.
    const input = terminal.onData((data) => {
      if (pasteCapture.current !== null) {
        pasteCapture.current += data;
        return;
      }
      if (isTerminalResponse(data)) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "response", data }));
        return;
      }
      if (touchScrolling) {
        send(data);
        return;
      }
      const { modifiers, onModifierUsed } = latest.current;
      if (modifiers.ctrl && data.length === 1 && /[a-z@\[\]\\^_?]/i.test(data))
        data =
          data === "?"
            ? "\x7f"
            : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
      if (modifiers.alt) data = "\x1b" + data;
      if (send(data) && (modifiers.ctrl || modifiers.alt)) onModifierUsed();
    });
    // xterm 6's native touch handler scrolls its buffer, but does not send TUI mouse wheels.
    const element = terminal.element!;
    const screen = element.querySelector<HTMLElement>(".xterm-screen")!;
    let touch:
      { id: number; y: number; remainder: number; moved: boolean } | undefined;
    const touchStart = (event: TouchEvent) => {
      touch = undefined;
      if (event.touches.length !== 1) return;
      const point = event.touches[0];
      touch = {
        id: point.identifier,
        y: point.clientY,
        remainder: 0,
        moved: false,
      };
      // Leave tap defaults intact, but avoid also starting xterm's native gesture handler.
      event.stopPropagation();
    };
    const touchMove = (event: TouchEvent) => {
      if (!touch) return;
      if (
        event.touches.length !== 1 ||
        event.touches[0].identifier !== touch.id
      ) {
        touch = undefined;
        return;
      }
      const point = event.touches[0];
      touch.remainder += touch.y - point.clientY;
      touch.y = point.clientY;
      event.stopPropagation();
      if (Math.abs(touch.remainder) < 6 && !touch.moved) return;
      touch.moved = true;
      event.preventDefault();
      const cellHeight = screen.getBoundingClientRect().height / terminal.rows;
      const mouse = terminal.modes.mouseTrackingMode !== "none";
      const step = Math.max(mouse ? 24 : 12, cellHeight);
      const lines = Math.trunc(touch.remainder / step);
      if (!lines) return;
      touch.remainder -= lines * step;
      if (!mouse || !latest.current.control) {
        terminal.scrollLines(lines);
        return;
      }
      touchScrolling = true;
      try {
        for (let i = 0; i < Math.min(12, Math.abs(lines)); i++)
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: point.clientX,
              clientY: point.clientY,
              deltaY: Math.sign(lines),
              deltaMode: WheelEvent.DOM_DELTA_LINE,
            }),
          );
      } finally {
        touchScrolling = false;
      }
    };
    const touchEnd = (event: TouchEvent) => {
      if (!touch) return;
      event.stopPropagation();
      if (touch.moved) event.preventDefault();
      touch = undefined;
    };
    const touches = {
      touchstart: touchStart,
      touchmove: touchMove,
      touchend: touchEnd,
      touchcancel: touchEnd,
    };
    for (const [event, handler] of Object.entries(touches))
      element.addEventListener(event, handler as EventListener, {
        capture: true,
        passive: event === "touchstart",
      });
    let resizeFrame = 0;
    const refit = () => {
      if (disposed) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return;
        // Drain pending escape sequences before changing the grid they were authored for.
        terminal.write("", () => {
          if (disposed) return;
          fit();
        });
      });
    };
    const resize = new ResizeObserver(refit);
    resize.observe(host.current!);
    void document.fonts.ready.then(refit);
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        ws.readyState === WebSocket.CLOSED
      )
        setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      ready.current = false;
      cancelPaste();
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      cancelAnimationFrame(resizeFrame);
      for (const finish of pending.current.values())
        finish(
          "Terminal disconnected before delivery was confirmed. Check the terminal before resending.",
        );
      document.removeEventListener("visibilitychange", visible);
      resize.disconnect();
      for (const [event, handler] of Object.entries(touches))
        element.removeEventListener(event, handler as EventListener, true);
      input.dispose();
      ws.close();
      socket.current = null;
      terminal.dispose();
      term.current = null;
    };
  }, [session, created, windowId, control, fitScreen, attempt]);
  useEffect(() => {
    if (!term.current) return;
    term.current.options.fontSize = fontSize;
    fit();
  }, [fontSize]);
  return (
    <div className="terminal-wrap">
      <div
        ref={host}
        className="terminal-canvas"
        aria-label={`${control ? "Interactive" : "Read-only"} terminal`}
      />
      {state !== "connected" && (
        <div className="connection-overlay">
          <span className="status-dot" />
          {state}
          <button onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
        </div>
      )}
    </div>
  );
}
