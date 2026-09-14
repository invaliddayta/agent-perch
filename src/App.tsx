import { piImageReference } from "./image-reference";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  LoaderCircle,
  Mic,
  Pin,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react";
import { Terminal, type TerminalHandle, type PasteTarget } from "./Terminal";
import type { Backend, Session } from "./types";
import { useSessions, sessionKey, errorText } from "./sessions";
import { eventLabel, stateLabel, unreadEvents } from "./status";
import { createVoice, type Voice, type VoiceState } from "./voice";
import {
  terminalEscape,
  terminalFullscreen,
  type KeyboardLock,
} from "./keyboard";

function storedSeen(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem("perch-seen") || "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  } catch {}
  return {};
}

export function App() {
  const [selected, setSelected] = useState<string>();
  const [windowId, setWindowId] = useState<string>();
  const [visible, setVisible] = useState<string>();
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const { snapshot, offline, create, kill } = useSessions(setError);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<
    | "sessions"
    | "new"
    | "settings"
    | "copy"
    | { target: PasteTarget; clipboard: Promise<string> }
  >();
  const [killTarget, setKillTarget] = useState<Session>();
  const [seen, setSeen] = useState(storedSeen);
  const [fontSize, setFontSize] = useState(13);
  const [fitScreen, setFitScreen] = useState(true);
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false });
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("aw-pins") || "[]",
      );
      return Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [clipboard, setClipboard] = useState<string>();
  const clipboardRequest = useRef(0);
  const terminal = useRef<TerminalHandle>(null);
  const fullscreenPending = useRef(false);
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock })
    .keyboard;
  const voice = useRef<Voice | null>(null);
  const [autoSpeech, setAutoSpeech] = useState<boolean | null>(() => {
    try {
      const value = localStorage.getItem("perch-auto-speech");
      return value === null ? null : value === "true";
    } catch {
      return null;
    }
  });
  const voiceTarget = useRef<PasteTarget | undefined>(undefined);
  const transfer = useRef(false);
  const [progress, setProgress] = useState("");
  const [recovery, setRecovery] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>({
    phase: "unloaded",
    message: "Voice is not loaded.",
  });
  const session = snapshot?.sessions.find((s) => sessionKey(s) === selected);
  const pane =
    session?.panes.find((p) => p.id === visible) ||
    session?.panes.find(
      (p) => p.active && (windowId ? p.windowId === windowId : p.windowActive),
    );
  const windows = [
    ...new Map(session?.panes.map((p) => [p.windowId, p]) || []).values(),
  ];
  const canDictate =
    connection === "connected" && pane?.command === "opencode" && !!visible;
  const imageBackend =
    pane?.backend === "pi" || pane?.command === "pi" ? "pi" : "opencode";
  const canPasteImage =
    connection === "connected" &&
    !!visible &&
    (canDictate || imageBackend === "pi");
  const unread = unreadEvents(snapshot?.sessions || [], seen);
  const unreadCount = new Set(unread.map(({ session }) => sessionKey(session)))
    .size;
  const attention = unread[0];

  useEffect(() => {
    document.title = unreadCount
      ? `(${unreadCount}) Agent Perch`
      : "Agent Perch";
  }, [unreadCount]);
  useEffect(() => {
    const syncSeen = (event: StorageEvent) => {
      if (event.key === "perch-seen" || event.key === null)
        setSeen(storedSeen());
    };
    window.addEventListener("storage", syncSeen);
    return () => window.removeEventListener("storage", syncSeen);
  }, []);

  function markSeen(key: string, id: string) {
    // Bound browser-only acknowledgments; no terminal or conversation text.
    const next = Object.fromEntries(
      [
        ...Object.entries({ ...seen, ...storedSeen() }).filter(
          ([k]) => k !== key,
        ),
        [key, id],
      ].slice(-500),
    );
    setSeen(next);
    try {
      localStorage.setItem("perch-seen", JSON.stringify(next));
    } catch {}
  }

  useEffect(() => {
    const resize = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        `${window.visualViewport?.height || window.innerHeight}px`,
      );
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.visualViewport?.removeEventListener("resize", resize);
      voice.current?.dispose();
      voice.current = null;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("aw-pins", JSON.stringify(pins));
    } catch {}
  }, [pins]);
  useEffect(() => {
    if (!modal && !killTarget && matchMedia("(pointer: fine)").matches)
      terminal.current?.focus();
  }, [modal, killTarget, selected, connection]);
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (killTarget) return;
    if (
      session &&
      !modal &&
      terminalEscape(event, () => {
        special("\x1b");
        terminal.current?.focus();
      })
    )
      return;
    if (
      event.isComposing ||
      event.getModifierState("AltGraph") ||
      modal === "new" ||
      modal === "settings" ||
      typeof modal === "object"
    )
      return;
    if (
      event.code !== "KeyS" ||
      !event.ctrlKey ||
      !event.altKey ||
      event.shiftKey ||
      event.metaKey
    )
      return;
    // Capture before xterm; switching sessions must send no input to the agent.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) setModal(modal === "sessions" ? undefined : "sessions");
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcut(event);
    const onFullscreen = () => {
      if (!document.fullscreenElement) keyboard?.unlock();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFullscreen);
      keyboard?.unlock();
    };
  }, []);

  const cancelVoice = useCallback(() => {
    voiceTarget.current?.signal.removeEventListener("abort", cancelVoice);
    voiceTarget.current = undefined;
    voice.current?.cancel();
  }, []);
  function select(s?: Session) {
    terminal.current?.cancelPaste();
    const next = s ? sessionKey(s) : undefined;
    if (next !== selected || windowId) setVisible(undefined);
    setSelected(next);
    setWindowId(undefined);
    setModal(undefined);
    setModifiers({ ctrl: false, alt: false });
    setError("");
  }
  function rememberSpeech(enabled: boolean) {
    setAutoSpeech(enabled);
    try {
      localStorage.setItem("perch-auto-speech", String(enabled));
    } catch {}
  }
  function getVoice() {
    if (autoSpeech === null) rememberSpeech(true);
    return (voice.current ??= createVoice(setVoiceState, (text) => {
      const target = voiceTarget.current;
      target?.signal.removeEventListener("abort", cancelVoice);
      voiceTarget.current = undefined;
      if (target) void paste(text, target);
    }));
  }
  const prepareSpeech = useEffectEvent(() => {
    // Loading failures remain visible in Settings; terminal use stays independent.
    void getVoice()
      .prepare()
      .catch(() => {});
  });
  useEffect(() => {
    if (autoSpeech && snapshot?.voiceReady && !voice.current) prepareSpeech();
  }, [autoSpeech, snapshot?.voiceReady]);

  async function microphone() {
    try {
      if (voiceState.phase === "recording") {
        await getVoice().stop();
        return;
      }
      if (!canDictate || transfer.current) return;
      if (!voiceTarget.current) {
        voiceTarget.current = terminal.current!.capturePasteTarget();
        voiceTarget.current.signal.addEventListener("abort", cancelVoice, {
          once: true,
        });
      }
      await getVoice().start();
    } catch (error) {
      cancelVoice();
      setError(errorText(error));
    }
  }
  async function paste(content: File[] | string, target?: PasteTarget) {
    const busy = transfer.current;
    const dictation = typeof content === "string";
    try {
      if (busy) throw new Error("Another paste is in progress.");
      target ??= (dictation ? canDictate : canPasteImage)
        ? terminal.current?.capturePasteTarget(
            dictation ? "opencode" : imageBackend,
          )
        : undefined;
      if (!target)
        throw new Error(
          "Open a connected OpenCode or Pi prompt before pasting images.",
        );
      transfer.current = true;
      setProgress(dictation ? "Pasting dictation..." : "Uploading image...");
      await target.ready;
      if (target.signal.aborted)
        throw new Error("The terminal changed. Text was not pasted.");
      for (const item of dictation ? [content] : content) {
        let text: string;
        if (typeof item === "string") text = item;
        else {
          if (item.size > 10 * 1024 * 1024)
            throw new Error("Each image must be at most 10 MiB.");
          const response = await fetch("/api/images", {
            method: "POST",
            headers: { "Content-Type": item.type, "X-Agent-Watch": "1" },
            body: item,
            signal: AbortSignal.any([
              target.signal,
              AbortSignal.timeout(60000),
            ]),
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || "Image upload failed.");
          text =
            imageBackend === "pi" ? piImageReference(result.path) : result.path;
        }
        await target.paste(text);
      }
      if (!dictation)
        setNotice(
          "Image file reference pasted. Review before submitting; Pi must read the host file.",
        );
    } catch (error) {
      if (dictation)
        setRecovery((old) => [old, content].filter(Boolean).join("\n"));
      setError(
        `${errorText(error)}${dictation ? " Inspect the prompt before retrying." : ""}`,
      );
    } finally {
      if (!busy) {
        transfer.current = false;
        setProgress("");
      }
    }
  }
  async function copy(text = clipboard) {
    if (text === undefined) return;
    const request = clipboardRequest.current;
    try {
      await navigator.clipboard.writeText(text);
      if (text === clipboard && request === clipboardRequest.current)
        setClipboard(undefined);
    } catch (error) {
      setError(errorText(error));
    }
  }
  function special(key: string) {
    const { ctrl, alt } = modifiers;
    if ((ctrl || alt) && /^\x1b\[[ABCD]$/.test(key))
      key = `\x1b[1;${1 + (ctrl ? 4 : 0) + (alt ? 2 : 0)}${key.at(-1)}`;
    else if (alt) key = "\x1b" + key;
    if (terminal.current?.key(key)) setModifiers({ ctrl: false, alt: false });
    else setError("Wait for the live terminal connection before sending keys.");
  }
  async function fullscreen() {
    if (fullscreenPending.current) return;
    fullscreenPending.current = true;
    try {
      await terminalFullscreen(document, keyboard);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      fullscreenPending.current = false;
      if (matchMedia("(pointer: fine)").matches) terminal.current?.focus();
    }
  }
  const list = (
    <SessionList
      sessions={snapshot?.sessions}
      backends={snapshot?.backends || []}
      pins={pins}
      seen={seen}
      selected={selected}
      offline={offline}
      onSelect={select}
      onNew={() => setModal("new")}
      onKill={(target) => {
        cancelVoice();
        setKillTarget(target);
      }}
    />
  );

  return (
    <div className="app">
      <header className="toolbar">
        {session ? (
          <>
            <button
              aria-label="Switch session"
              aria-keyshortcuts="Control+Alt+S"
              title="Switch session (Ctrl+Alt+S)"
              onClick={() => setModal("sessions")}
            >
              Sessions{unreadCount ? ` [${unreadCount}]` : ""}
            </button>
            <strong className="session-name">{session.name}</strong>
            {windows.length > 1 && (
              <select
                aria-label="Select window"
                value={windowId || ""}
                onChange={(e) => {
                  terminal.current?.cancelPaste();
                  setVisible(undefined);
                  setWindowId(e.target.value || undefined);
                }}
              >
                <option value="">Current window</option>
                {windows.map((p) => (
                  <option key={p.windowId} value={p.windowId}>
                    {p.windowName}
                  </option>
                ))}
              </select>
            )}
            <button
              aria-label="Pin session"
              aria-pressed={pins.includes(selected!)}
              title="Pin session"
              onClick={() =>
                setPins((old) =>
                  old.includes(selected!)
                    ? old.filter((key) => key !== selected)
                    : [...old, selected!],
                )
              }
            >
              Pin
            </button>
            <button
              aria-label="Toggle fullscreen"
              title="Toggle fullscreen"
              onClick={() => void fullscreen()}
            >
              Full
            </button>
          </>
        ) : (
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              select();
            }}
          >
            <span aria-hidden="true">&gt;</span>
            agent perch
          </a>
        )}
        <span className="connection">
          {offline
            ? "Host offline"
            : session
              ? connection
              : snapshot
                ? "tmux"
                : "connecting"}
        </span>
        <button
          aria-label="Settings"
          title="Settings"
          onClick={() => setModal("settings")}
        >
          Settings
        </button>
      </header>
      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {attention && !offline && (
        <div
          className={`attention-banner status-${attention.event.state}`}
          role="status"
        >
          <span>
            <strong>{attention.session.name}</strong>:{" "}
            {eventLabel[attention.event.state]}
          </span>
          {(selected !== sessionKey(attention.session) ||
            pane?.id !== attention.pane.id) && (
            <button
              onClick={() => {
                select(attention.session);
                setWindowId(attention.pane.windowId);
              }}
            >
              Open terminal
            </button>
          )}
          <button onClick={() => markSeen(attention.key, attention.event.id)}>
            Mark seen
          </button>
        </div>
      )}
      {session ? (
        <main
          className="workspace"
          onPasteCapture={(event) => {
            const files = Array.from(event.clipboardData.items)
              .filter(
                (item) =>
                  item.kind === "file" && item.type.startsWith("image/"),
              )
              .map((item) => item.getAsFile())
              .filter((file): file is File => !!file);
            if (!files.length) return;
            event.preventDefault();
            event.stopPropagation();
            void paste(files);
          }}
        >
          <Terminal
            key={sessionKey(session)}
            ref={terminal}
            session={session.id}
            created={session.created}
            windowId={windowId}
            control
            fitScreen={fitScreen}
            fontSize={fontSize}
            modifiers={modifiers}
            onModifierUsed={() => setModifiers({ ctrl: false, alt: false })}
            onState={setConnection}
            onPane={setVisible}
            onClipboard={(text, automatic) => {
              const request = ++clipboardRequest.current;
              setClipboard(text);
              if (automatic)
                void navigator.clipboard
                  ?.writeText(text)
                  .then(() => {
                    if (request === clipboardRequest.current)
                      setClipboard(undefined);
                  })
                  .catch(() => {});
            }}
          />
          <div
            className="terminal-controls"
            onPointerDown={(event) => {
              if ((event.target as Element).closest("button"))
                event.preventDefault();
            }}
          >
            <div className="keybar" aria-label="Special terminal keys">
              {(["ctrl", "alt"] as const).map((key) => (
                <button
                  key={key}
                  aria-pressed={modifiers[key]}
                  onClick={() => {
                    setModifiers((old) => ({ ...old, [key]: !old[key] }));
                    terminal.current?.focus();
                  }}
                >
                  {key === "ctrl" ? "Ctrl" : "Alt"}
                </button>
              ))}
              <button
                className="escape-key"
                title="Send Escape to terminal (Ctrl+[ also works with terminal focus)"
                onClick={() => special("\x1b")}
              >
                Esc
              </button>
              <button onClick={() => special("\t")}>Tab</button>
            </div>
            <div
              className="navigation-keys"
              aria-label="Terminal navigation keys"
            >
              {(
                [
                  ["left", "D", ArrowLeft],
                  ["up", "A", ArrowUp],
                  ["down", "B", ArrowDown],
                  ["right", "C", ArrowRight],
                ] as const
              ).map(([label, code, Icon]) => (
                <button
                  key={code}
                  aria-label={`Arrow ${label}`}
                  onClick={() => special(`\x1b[${code}`)}
                >
                  <Icon size={16} />
                </button>
              ))}
              <button aria-label="Enter" onClick={() => special("\r")}>
                <CornerDownLeft size={17} />
              </button>
            </div>
            <div className="terminal-actions">
              <button
                aria-label="Select terminal text"
                title="Select terminal text to copy"
                onClick={() => setModal("copy")}
              >
                <Copy size={17} />
              </button>
              <button
                aria-label="Paste text"
                title="Paste text into terminal"
                disabled={connection !== "connected" || !visible}
                onClick={() => {
                  try {
                    const target =
                      terminal.current!.capturePasteTarget("terminal");
                    let clipboard: Promise<string>;
                    // Read during the tap; Safari requires user activation.
                    try {
                      clipboard = navigator.clipboard.readText();
                    } catch (error) {
                      clipboard = Promise.reject(error);
                    }
                    void clipboard.catch(() => {});
                    setModal({ target, clipboard });
                  } catch (error) {
                    setError(errorText(error));
                  }
                }}
              >
                <ClipboardPaste size={17} />
              </button>
              <button
                className={voiceState.phase === "recording" ? "recording" : ""}
                aria-label={
                  voiceState.phase === "recording"
                    ? "Stop recording"
                    : "Dictate on device"
                }
                title="Dictate into OpenCode"
                disabled={
                  voiceState.phase !== "recording" &&
                  (voiceState.phase === "transcribing" ||
                    !!progress ||
                    !snapshot?.voiceReady ||
                    !canDictate)
                }
                onClick={() => void microphone()}
              >
                {voiceState.phase === "recording" ? (
                  <Square size={17} />
                ) : (
                  <Mic size={17} />
                )}
              </button>
              {["loading", "recording", "transcribing"].includes(
                voiceState.phase,
              ) && (
                <button aria-label="Cancel dictation" onClick={cancelVoice}>
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
          {(progress ||
            ["loading", "recording", "transcribing", "error"].includes(
              voiceState.phase,
            )) && (
            <div
              className="progress"
              role={voiceState.phase === "error" ? "alert" : "status"}
            >
              {progress || voiceState.message}
            </div>
          )}
        </main>
      ) : (
        <main className="overview">
          {list}
          <p className="quiet">
            <kbd>Ctrl+Alt+S</kbd> switch sessions. Closing the tab leaves tmux
            running.
          </p>
        </main>
      )}
      {recovery && (
        <div className="recovery" role="alert">
          <details>
            <summary>Dictation could not be delivered</summary>
            <p>{recovery}</p>
          </details>
          <button onClick={() => void copy(recovery)}>Copy text</button>
          <button
            aria-label="Dismiss dictation"
            onClick={() => setRecovery("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {clipboard !== undefined && (
        <div className="clipboard" role="status">
          <span>Terminal text is ready to copy.</span>
          <button onClick={() => void copy()}>Copy to clipboard</button>
          <button
            aria-label="Dismiss clipboard request"
            onClick={() => {
              clipboardRequest.current++;
              setClipboard(undefined);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "sessions" && (
        <Modal title="Sessions" onClose={() => setModal(undefined)}>
          {list}
          <button className="home-button" onClick={() => select()}>
            Session manager
          </button>
        </Modal>
      )}
      {modal === "new" && (
        <NewSession
          backends={snapshot?.backends || []}
          defaultDirectory={snapshot?.projectsRoot || "~"}
          onClose={() => setModal(undefined)}
          onCreate={async (body) => select(await create(body))}
        />
      )}
      {modal === "copy" && (
        <CopyTerminalText
          getText={() => terminal.current?.visibleText() || ""}
          onClose={() => setModal(undefined)}
        />
      )}
      {typeof modal === "object" && (
        <PasteTerminalText
          target={modal.target}
          clipboard={modal.clipboard}
          onClose={() => setModal(undefined)}
        />
      )}
      {killTarget && (
        <KillSession
          session={killTarget}
          onClose={() => setKillTarget(undefined)}
          onKill={async () => {
            await kill(killTarget);
            const key = sessionKey(killTarget);
            setPins((old) => old.filter((pin) => pin !== key));
            setKillTarget(undefined);
            if (selected === key) select();
          }}
        />
      )}
      {modal === "settings" && (
        <Modal title="Settings" onClose={() => setModal(undefined)}>
          <label className="field">
            Terminal text size: {fontSize}px
            <input
              type="range"
              data-initial-focus
              min="10"
              max="22"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <input
              type="checkbox"
              checked={fitScreen}
              onChange={(e) => setFitScreen(e.target.checked)}
            />{" "}
            Fit the terminal to this screen
            <small>
              Turn off to preserve another attached client's layout.
            </small>
          </label>
          {session && (
            <>
              <label className="field">
                Find in terminal history
                <input
                  type="search"
                  placeholder="Search and press Enter"
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      terminal.current?.search(e.currentTarget.value);
                  }}
                />
              </label>
              <div className="button-row">
                <button
                  onClick={() =>
                    void terminal.current
                      ?.copy()
                      .catch((error) => setError(errorText(error)))
                  }
                >
                  <Copy size={16} /> Copy selection
                </button>
                <button onClick={() => terminal.current?.bottom()}>
                  <ArrowDownToLine size={16} /> Scroll to bottom
                </button>
              </div>
            </>
          )}
          <h3>Local dictation</h3>
          <p>
            Moonshine Medium transcribes English on this device using the CPU.
            About 304 MiB downloads from your host on first use; audio stays
            here. Dictation pastes into OpenCode; image references paste into
            OpenCode or Pi without submitting.
          </p>
          <label className="field">
            <input
              type="checkbox"
              checked={autoSpeech === true}
              onChange={(e) => rememberSpeech(e.target.checked)}
            />{" "}
            Prepare speech on startup
            <small>
              Enabled after first use and remembered in this browser. Turn off
              for manual loading on future visits. Never opens the microphone.
            </small>
          </label>
          <button
            disabled={
              !snapshot?.voiceReady ||
              ["loading", "recording", "transcribing"].includes(
                voiceState.phase,
              )
            }
            onClick={() =>
              void getVoice()
                .prepare()
                .catch((error) => setError(errorText(error)))
            }
          >
            Prepare speech
          </button>
          <p className="quiet" role="status">
            {snapshot?.voiceReady
              ? voiceState.message
              : "Run bun run voice:prepare and rebuild to enable speech."}
          </p>
          <h3>Private access only</h3>
          <p>
            Anyone who can reach Perch can control the host account. Use
            localhost or private HTTPS with access control. There is no built-in
            login.
          </p>
          <h3>Agent attention</h3>
          <p>
            New sessions report native agent events. Turn-finished and attention
            badges stay unread until you mark them seen, even after switching
            terminals. The tab title shows the number of sessions to check.
          </p>
          <p className="quiet">
            No prompt instructions are added. Existing sessions show no status
            until relaunched. Codex reports attention without distinguishing a
            finished turn from an approval or question. These are in-app
            indicators, not push notifications when the app is closed.
          </p>
          <h3>Install app</h3>
          <p>
            Use Install app in your browser menu, or Safari's Share / Add to
            Home Screen. The host must remain reachable.
          </p>
        </Modal>
      )}
    </div>
  );
}

function SessionList({
  sessions,
  backends,
  pins,
  seen,
  selected,
  offline,
  onSelect,
  onNew,
  onKill,
}: {
  sessions?: Session[];
  backends: Backend[];
  pins: string[];
  seen: Record<string, string>;
  selected?: string;
  offline: boolean;
  onSelect(session: Session): void;
  onNew(): void;
  onKill(session: Session): void;
}) {
  const [query, setQuery] = useState("");
  const list = (sessions || [])
    .filter((s) =>
      `${s.name} ${s.panes.map((p) => p.cwd).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(pins.includes(sessionKey(b))) -
          Number(pins.includes(sessionKey(a))) || a.name.localeCompare(b.name),
    );
  return (
    <section className="session-list" aria-label="Tmux sessions">
      <header className="panel-title">
        <span>Sessions</span>
        <span className="quiet">{sessions?.length ?? "..."}</span>
      </header>
      <div className="list-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            data-initial-focus
            type="search"
            aria-label="Search sessions"
            placeholder="Find a session..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                const buttons = e.currentTarget
                  .closest(".session-list")
                  ?.querySelectorAll<HTMLButtonElement>(".session-item");
                const next =
                  e.key === "ArrowDown"
                    ? buttons?.[0]
                    : buttons?.[buttons.length - 1];
                if (next) {
                  e.preventDefault();
                  next.focus();
                }
              }
              if (e.key === "Enter" && !e.nativeEvent.isComposing && list[0]) {
                e.preventDefault();
                onSelect(list[0]);
              }
            }}
          />
        </label>
        <button className="primary" onClick={onNew}>
          <Plus size={16} />
          New session
        </button>
      </div>
      <div
        className="sessions"
        onKeyDown={(event) => {
          if (
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".session-item",
            ),
          );
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {list.map((s) => {
          const pending = unreadEvents([s], seen)[0];
          const pane =
            pending?.pane ||
            s.panes.find((p) => p.status?.state === "working") ||
            s.panes.find((p) => p.active && p.windowActive) ||
            s.panes[0];
          const exited = !!s.panes.length && s.panes.every((p) => p.dead);
          return (
            <div className="session-row" key={sessionKey(s)}>
              <button
                className={`session-item ${selected === sessionKey(s) ? "selected" : ""} ${pending ? "has-attention" : ""}`}
                onClick={() => onSelect(s)}
              >
                <span className="session-info">
                  <strong>
                    {pending && (
                      <span
                        className={`unread-dot status-${pending.event.state}`}
                        aria-label="Unread agent notification"
                      />
                    )}
                    {pins.includes(sessionKey(s)) && <Pin size={12} />}
                    {s.name}
                  </strong>
                  <small title={pane?.cwd}>{pane?.cwd}</small>
                </span>
                <span className="agent">
                  {pane?.backend ||
                    pane?.status?.backend ||
                    pane?.command ||
                    "terminal"}
                </span>
                <span
                  className={`signal ${pending && !offline ? `status-${pending.event.state}` : ""}`}
                  title={
                    offline
                      ? "Host offline; agent state is unknown."
                      : pending
                        ? `${eventLabel[pending.event.state]}. Inspect the terminal; no action is taken automatically.`
                        : pane?.status
                          ? "Last native agent signal. Approval controls remain in the TUI."
                          : "Native status unavailable. Existing sessions are not modified; launch a new session for agent events."
                  }
                >
                  {offline
                    ? "Offline"
                    : exited
                      ? "Exited"
                      : pending
                        ? stateLabel[pending.event.state]
                        : pane?.status
                          ? stateLabel[pane.status.state]
                          : "No status"}
                </span>
                <ArrowRight size={14} />
              </button>
              <button
                className="session-kill danger"
                aria-label={`Kill session ${s.name}`}
                title={`Kill session ${s.name}`}
                disabled={offline}
                onClick={() => onKill(s)}
              >
                <X size={18} />
              </button>
            </div>
          );
        })}
        {!list.length && (
          <p className="empty">
            {!sessions
              ? "Connecting to your host..."
              : query
                ? "No matching sessions."
                : "No sessions. Start an agent in any accessible directory."}
          </p>
        )}
      </div>
      <div className="backends">
        {backends.map((b) => (
          <span key={b.id} className={b.available ? "available" : ""}>
            {b.label}: {b.available ? "available" : "unavailable"}
          </span>
        ))}
      </div>
    </section>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      element.close();
      // A confirmed kill can remove the trigger from the underlying switcher.
      queueMicrotask(() => {
        if (document.activeElement === document.body)
          Array.from(document.querySelectorAll("dialog[open]"))
            .at(-1)
            ?.querySelector<HTMLElement>("[data-initial-focus]")
            ?.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button aria-label="Close dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function CopyTerminalText({
  getText,
  onClose,
}: {
  getText(): string;
  onClose(): void;
}) {
  // A stable native text field gives phones selection handles without TUI input.
  const [text] = useState(getText);
  const [selection, setSelection] = useState("");
  const [status, setStatus] = useState("");
  const helpId = useId();
  async function copy(value: string) {
    setStatus("");
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied to clipboard.");
    } catch {
      setStatus(
        "Clipboard access was blocked or unavailable. Long-press the text and use the browser's Copy menu.",
      );
    }
  }
  return (
    <Modal title="Select terminal text" onClose={onClose}>
      <p id={helpId}>
        Snapshot of the visible terminal. Long-press or drag to select text,
        then copy. Close this view to scroll further in tmux.
      </p>
      <label className="field">
        Terminal text
        <textarea
          className="copy-text"
          aria-describedby={helpId}
          readOnly
          value={text}
          placeholder="No visible terminal text."
          spellCheck={false}
          onSelect={(event) => {
            const field = event.currentTarget;
            setSelection(
              field.value.slice(field.selectionStart, field.selectionEnd),
            );
          }}
        />
      </label>
      <div className="button-row">
        <button
          disabled={!selection}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void copy(selection)}
        >
          <Copy size={16} /> Copy selection
        </button>
        <button disabled={!text} onClick={() => void copy(text)}>
          Copy all
        </button>
      </div>
      <p role="status">{status}</p>
    </Modal>
  );
}

function PasteTerminalText({
  target,
  clipboard,
  onClose,
}: {
  target: PasteTarget;
  clipboard: Promise<string>;
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [reading, setReading] = useState(true);
  const [clipboardError, setClipboardError] = useState("");
  const [stale, setStale] = useState(target.signal.aborted);
  const edited = useRef(false);
  const { busy, error, close, submit } = useSubmission(onClose);
  const helpId = useId();
  useEffect(() => {
    let live = true;
    const abort = () => setStale(true);
    target.signal.addEventListener("abort", abort, { once: true });
    if (target.signal.aborted) abort();
    void clipboard.then(
      (value) => {
        if (!live) return;
        if (!edited.current) setText(value);
        setReading(false);
      },
      () => {
        if (!live) return;
        setClipboardError(
          "Clipboard access was blocked or unavailable. Long-press the field and choose Paste.",
        );
        setReading(false);
      },
    );
    return () => {
      live = false;
      target.signal.removeEventListener("abort", abort);
    };
  }, [target, clipboard]);
  return (
    <Modal title="Paste text" onClose={close}>
      <p id={helpId}>
        Review the text before pasting into the terminal. Enter is not sent. You
        can also long-press the field and choose Paste.
      </p>
      {reading && <p role="status">Reading clipboard...</p>}
      {clipboardError && <p role="status">{clipboardError}</p>}
      <label className="field">
        Text to paste
        <textarea
          className="paste-text"
          aria-describedby={helpId}
          value={text}
          readOnly={busy}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            edited.current = true;
            setText(event.currentTarget.value);
          }}
        />
      </label>
      {(stale || error) && (
        <p className="form-error" role="alert">
          {stale
            ? "The terminal changed. Close this dialog and reopen Paste in the intended pane."
            : error}
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy || stale || !text}
          onClick={() =>
            void submit(async () => {
              await target.paste(text);
              onClose();
            }, "Inspect the terminal before retrying.")
          }
        >
          <ClipboardPaste size={16} />{" "}
          {busy ? "Pasting..." : "Paste into terminal"}
        </button>
        <button disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function useSubmission(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  return {
    busy,
    error,
    close: () => {
      if (!submitting.current) onClose();
    },
    async submit(action: () => Promise<void>, hint: string) {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      setError("");
      try {
        await action();
      } catch (error) {
        setError(`${errorText(error)} ${hint}`);
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
  };
}

function KillSession({
  session,
  onClose,
  onKill,
}: {
  session: Session;
  onClose(): void;
  onKill(): Promise<void>;
}) {
  const { busy, error, close, submit } = useSubmission(onClose);
  return (
    <Modal title="Kill session?" onClose={close}>
      <p>
        End <code>{session.name}</code> and disconnect its viewers?
      </p>
      <p>
        This stops the session's running agents and commands. Unsaved work may
        be lost. This cannot be undone.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button data-initial-focus disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            void submit(onKill, "Check the session list before retrying.")
          }
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}
          {busy ? "Killing session..." : "Kill session"}
        </button>
      </div>
    </Modal>
  );
}

function NewSession({
  backends,
  defaultDirectory,
  onClose,
  onCreate,
}: {
  backends: Backend[];
  defaultDirectory: string;
  onClose(): void;
  onCreate(body: unknown): Promise<void>;
}) {
  const [chosen, setChosen] = useState<string>();
  const backend =
    backends.find((b) => b.id === chosen) ||
    backends.find((b) => b.available) ||
    backends[0];
  const { busy, error, close, submit } = useSubmission(onClose);
  return (
    <Modal title="New session" onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!backend?.available) return;
          const fields = new FormData(event.currentTarget);
          void submit(
            () =>
              onCreate({
                backend: backend.id,
                directory: fields.get("directory"),
                name: fields.get("name"),
                createDirectory: fields.has("createDirectory"),
                prompt: backend.initialPrompt ? fields.get("prompt") : "",
              }),
            "If delivery was uncertain, check the session list before retrying.",
          );
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            Directory
            <input
              data-initial-focus
              name="directory"
              required
              placeholder="~/src/my-project"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <small>
              Path on the host. Relative paths start at{" "}
              <code>{defaultDirectory}</code>.
            </small>
          </label>
          <label className="field">
            <input type="checkbox" name="createDirectory" defaultChecked />{" "}
            Create directory if it doesn't exist
          </label>
          <label className="field">
            Agent
            <select
              value={backend?.id || ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              {backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                  {b.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
            <small>
              Uses the CLI's own authentication and approval settings.
            </small>
          </label>
          <label className="field">
            Session name{" "}
            <small>Optional; defaults to the directory name.</small>
            <input
              name="name"
              pattern={"[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,47}"}
              maxLength={48}
              placeholder="Use directory name"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Starting prompt <small>Optional</small>
            <textarea
              name="prompt"
              rows={3}
              maxLength={30000}
              disabled={!backend?.initialPrompt}
              placeholder="What should the agent work on?"
            />
            {!backend?.initialPrompt && (
              <small>
                This CLI has no starting-prompt flag. Enter your prompt in the
                terminal.
              </small>
            )}
          </label>
          {!backend?.available && (
            <p className="form-error">
              Install this CLI or configure its executable on the host. Existing
              terminals still work.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={!backend?.available}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
            {busy ? "Starting session..." : "Create session"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
