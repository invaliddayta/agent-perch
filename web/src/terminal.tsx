/**
 * A tmux session in the browser (xterm.js over web/term.ts). Phone first: a key bar for the keys a
 * soft keyboard lacks, a line composer that keeps the phone's autocorrect and dictation, touch
 * scrolling through tmux history, a copyable history view, and reconnects.
 */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "preact/hooks";
import { SessionList } from "./parts.tsx";
import { api, type Snapshot, shown } from "./store.ts";
import { copyText, Dot, Icon } from "./ui.tsx";

type Conn = "connecting" | "live" | "closed" | "error";
type Grid = { cols: number; rows: number; shared: boolean; by: string | null };

const FONT = '"Perch Mono", "DejaVu Sans Mono", ui-monospace, Menlo, monospace';
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const fontKey = (desk: boolean) => (desk ? "np-font-desk" : "np-font-phone");

function sessionState(s: Snapshot, name: string): string {
	if (name === "boss") return s.boss?.state ?? "idle";
	const w = s.workers.find((x) => x.tmux === name && x.state !== "stopped");
	return w ? shown(s, w) : "stopped";
}

export function TermView({ name, active, s, desk }: { name: string; active: boolean; s: Snapshot; desk: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const api_ = useRef<{
		send: (d: string) => void;
		key: (d: string) => void;
		arrow: (c: string) => void;
		paste: (t: string, enter: boolean) => void;
		setFont: (n: number) => void;
		setMode: (m: "auto" | "fit") => void;
		reconnect: () => void;
		focus: () => void;
		blur: () => void;
	} | null>(null);
	const [conn, setConn] = useState<Conn>("connecting");
	const [grid, setGrid] = useState<Grid | null>(null);
	const [err, setErr] = useState("");
	const [font, setFontState] = useState(() => Number(localStorage.getItem(fontKey(desk))) || (desk ? 13 : 12));
	const [ctrl, setCtrl] = useState(false);
	const [fit, setFit] = useState(false); // took the size over explicitly
	const [compose, setCompose] = useState(!desk);
	const [line, setLine] = useState("");
	const [hist, setHist] = useState<string | null>(null);
	const [pick, setPick] = useState(false);
	const [toast, setToast] = useState("");
	const ctrlRef = useRef(false);
	ctrlRef.current = ctrl;
	const activeRef = useRef(active);
	activeRef.current = active;

	useEffect(() => {
		const el = host.current!;
		const term = new Terminal({
			fontFamily: FONT,
			fontSize: font,
			lineHeight: 1.1,
			cursorBlink: true,
			scrollback: 2000,
			allowProposedApi: false,
			macOptionIsMeta: true,
			theme: {
				background: "#0a0c0f",
				foreground: "#dfe3e8",
				cursor: "#f5c451",
				cursorAccent: "#0a0c0f",
				selectionBackground: "#3b4a63",
				black: "#1b1f24",
				red: "#ef8a80",
				green: "#9fd38a",
				yellow: "#e8c77d",
				blue: "#86b0e0",
				magenta: "#c9a0dc",
				cyan: "#7fc4be",
				white: "#dfe3e8",
				brightBlack: "#6b7480",
				brightRed: "#ffa198",
				brightGreen: "#b8e6a3",
				brightYellow: "#f5d996",
				brightBlue: "#a5c8f0",
				brightMagenta: "#dcb8ec",
				brightCyan: "#9fdcd5",
				brightWhite: "#ffffff",
			},
		});
		const fitter = new FitAddon();
		term.loadAddon(fitter);
		term.open(el);
		// Ctrl+Shift+C copies the selection (Shift+drag selects even while tmux owns the mouse);
		// Ctrl/Cmd+V is left to the browser so a paste arrives as a paste.
		term.attachCustomKeyEventHandler((e) => {
			if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC") {
				const sel = term.getSelection();
				if (sel) void copyText(sel).then((ok) => flash(ok ? "copied" : "copy failed"));
				return false;
			}
			if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyV") return false;
			return true;
		});

		let ws: WebSocket | null = null;
		let disposed = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let backoff = 500;
		let userFont = font;
		let g: Grid | null = null;
		let mode: "auto" | "fit" | "passive" = "auto";
		const sendCtl = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
		const send = (d: string) => sendCtl({ t: "in", d });

		/** Columns/rows that fit the box at the user's font size. */
		function fitSize(): [number, number] | undefined {
			const cur = term.options.fontSize ?? userFont;
			const p = fitter.proposeDimensions();
			if (!p || !p.cols || !p.rows) return undefined;
			const k = cur / userFont;
			return [Math.max(20, Math.floor(p.cols * k)), Math.max(5, Math.floor(p.rows * k))];
		}
		/** Shared view: shrink the font until the other client's grid fits (never below 5px). */
		function layout() {
			if (!g) return;
			if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows);
			let size = userFont;
			term.options.fontSize = size;
			if (g.shared) {
				for (let i = 0; i < 40 && size > 5; i++) {
					const p = fitter.proposeDimensions();
					if (p && p.cols >= g.cols && p.rows >= g.rows) break;
					size = Math.max(5, size - 0.5);
					term.options.fontSize = size;
				}
			}
		}
		let sizeTimer: ReturnType<typeof setTimeout> | undefined;
		function reportSize() {
			clearTimeout(sizeTimer);
			sizeTimer = setTimeout(() => {
				const f = fitSize();
				if (!f) return;
				if (!g?.shared && (term.cols !== f[0] || term.rows !== f[1])) term.resize(f[0], f[1]);
				sendCtl({ t: "size", cols: f[0], rows: f[1] });
			}, 80);
		}

		function connect() {
			if (disposed) return;
			setConn("connecting");
			term.options.fontSize = userFont;
			const f = fitSize() ?? [80, 24];
			const u = new URL("/api/term", location.href);
			u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
			u.searchParams.set("session", name);
			u.searchParams.set("cols", String(f[0]));
			u.searchParams.set("rows", String(f[1]));
			u.searchParams.set("mode", mode);
			const sock = new WebSocket(u);
			sock.binaryType = "arraybuffer";
			ws = sock;
			sock.onopen = () => {
				backoff = 500;
				setErr("");
				setConn("live");
				term.reset();
			};
			sock.onmessage = (e) => {
				if (typeof e.data !== "string") return term.write(new Uint8Array(e.data));
				const m = JSON.parse(e.data);
				if (m.t === "grid") {
					g = { cols: m.cols, rows: m.rows, shared: m.shared, by: m.by };
					setGrid(g);
					layout();
				} else if (m.t === "error") setErr(m.message);
			};
			sock.onclose = (e) => {
				if (ws !== sock || disposed) return;
				setConn(e.code === 1000 ? "closed" : "error");
				if (e.code !== 1000) {
					retry = setTimeout(connect, backoff);
					backoff = Math.min(8000, backoff * 2);
				}
			};
		}

		const onData = term.onData((d) => {
			if (ctrlRef.current && d.length === 1) {
				const c = d.toUpperCase().charCodeAt(0);
				if (c >= 64 && c <= 95) d = String.fromCharCode(c & 31);
				else if (d === " ") d = "\x00";
				setCtrl(false);
			}
			send(d);
		});
		const onSel = term.onSelectionChange(() => {
			const sel = term.getSelection();
			if (sel && sel.length > 1) void copyText(sel).then((ok) => ok && flash("copied selection"));
		});

		// Touch: one finger scrolls tmux history (as mouse wheel, so tmux enters copy mode);
		// a tap still focuses the terminal and opens the keyboard.
		const xel = term.element!;
		const screen = xel.querySelector<HTMLElement>(".xterm-screen")!;
		let touch: { id: number; y: number; rest: number; moved: boolean } | undefined;
		const tStart = (e: TouchEvent) => {
			touch = undefined;
			if (e.touches.length !== 1) return;
			touch = { id: e.touches[0].identifier, y: e.touches[0].clientY, rest: 0, moved: false };
			e.stopPropagation();
		};
		const tMove = (e: TouchEvent) => {
			if (!touch) return;
			const t = e.touches[0];
			if (e.touches.length !== 1 || t.identifier !== touch.id) return void (touch = undefined);
			touch.rest += touch.y - t.clientY;
			touch.y = t.clientY;
			e.stopPropagation();
			if (Math.abs(touch.rest) < 8 && !touch.moved) return;
			touch.moved = true;
			e.preventDefault();
			const cell = screen.getBoundingClientRect().height / term.rows;
			const mouse = term.modes.mouseTrackingMode !== "none";
			const step = Math.max(mouse ? 20 : 10, cell);
			const lines = Math.trunc(touch.rest / step);
			if (!lines) return;
			touch.rest -= lines * step;
			if (!mouse) return term.scrollLines(lines);
			for (let i = 0; i < Math.min(10, Math.abs(lines)); i++)
				xel.dispatchEvent(
					new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY, deltaY: Math.sign(lines), deltaMode: WheelEvent.DOM_DELTA_LINE }),
				);
		};
		const tEnd = (e: TouchEvent) => {
			if (!touch) return;
			e.stopPropagation();
			if (touch.moved) e.preventDefault();
			touch = undefined;
		};
		xel.addEventListener("touchstart", tStart, { capture: true, passive: true });
		xel.addEventListener("touchmove", tMove, { capture: true, passive: false });
		xel.addEventListener("touchend", tEnd, { capture: true, passive: false });
		xel.addEventListener("touchcancel", tEnd, { capture: true, passive: false });

		const ro = new ResizeObserver(() => {
			if (!el.clientWidth || !el.clientHeight) return; // hidden
			if (g?.shared) layout();
			reportSize();
		});
		ro.observe(el);
		void document.fonts.ready.then(() => {
			term.options.fontFamily = FONT; // re-measure once the font is in
			reportSize();
		});

		// A hidden tab or view never decides the window size.
		const visibility = () => {
			const want = document.hidden || !activeRef.current ? "passive" : fitMode ? "fit" : "auto";
			if (want !== mode) {
				mode = want;
				sendCtl({ t: "mode", mode });
			}
			if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) {
				clearTimeout(retry);
				connect();
			}
		};
		let fitMode = false;
		document.addEventListener("visibilitychange", visibility);
		const ping = setInterval(() => sendCtl({ t: "ping" }), 25_000);

		let toastTimer: ReturnType<typeof setTimeout> | undefined;
		function flash(t: string) {
			setToast(t);
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => setToast(""), 1400);
		}

		api_.current = {
			send,
			key: (d) => {
				send(d);
				if (desk) term.focus();
			},
			// Full-screen apps switch to application cursor keys (ESC O x instead of ESC [ x).
			arrow: (c) => {
				send(term.modes.applicationCursorKeysMode ? `\x1bO${c}` : `\x1b[${c}`);
				if (desk) term.focus();
			},
			paste: (t, enter) => {
				if (t) {
					// Bracketed paste when the app asked for it, so a multi-line message stays one message.
					send(term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t);
				}
				if (enter) setTimeout(() => send("\r"), t ? 60 : 0);
			},
			setFont: (n) => {
				userFont = n;
				layout();
				if (!g?.shared) term.options.fontSize = n;
				reportSize();
			},
			setMode: (m) => {
				fitMode = m === "fit";
				visibility();
				sendCtl({ t: "mode", mode });
			},
			reconnect: () => {
				clearTimeout(retry);
				ws?.close(1000);
				connect();
			},
			focus: () => term.focus(),
			blur: () => term.blur(),
		};
		(api_.current as any).visibility = visibility;
		(api_.current as any).flash = flash;
		mode = document.hidden || !activeRef.current ? "passive" : "auto";
		connect();

		return () => {
			disposed = true;
			clearTimeout(retry);
			clearInterval(ping);
			ro.disconnect();
			document.removeEventListener("visibilitychange", visibility);
			onData.dispose();
			onSel.dispose();
			ws?.close(1000);
			term.dispose();
			api_.current = null;
		};
	}, [name]);

	// Going to another view makes this terminal passive; coming back makes it size again.
	useEffect(() => {
		(api_.current as any)?.visibility?.();
	}, [active]);

	function changeFont(d: number) {
		const n = Math.max(7, Math.min(24, font + d));
		setFontState(n);
		localStorage.setItem(fontKey(desk), String(n));
		api_.current?.setFont(n);
	}
	function toggleFit() {
		const next = !fit;
		setFit(next);
		api_.current?.setMode(next ? "fit" : "auto");
	}
	async function openHistory() {
		setHist("");
		const r = await api<{ text: string }>(`/api/history?session=${encodeURIComponent(name)}`);
		setHist(r.error ? `(${r.error})` : r.text || "(empty)");
	}
	const arrow = (c: string) => api_.current?.arrow(c);
	const st = sessionState(s, name);
	const sharedNote = grid?.shared && active && !fit;

	return (
		<div class={`view termview ${active ? "" : "hidden"}`}>
			<header class="vh term-h">
				<button class="tname" onClick={() => setPick(!pick)} aria-expanded={pick}>
					<Dot s={st} pulse={st === "needs"} />
					<b>{name}</b>
					<Icon n="down" size={14} />
				</button>
				<span class={`conn ${conn}`}>{conn === "live" ? (grid ? `${grid.cols}×${grid.rows}` : "live") : conn === "connecting" ? "connecting…" : conn === "closed" ? "detached" : "reconnecting…"}</span>
				<span class="sp" />
				<button class="iconbtn" onClick={() => changeFont(-1)} aria-label="Smaller text" title="Smaller text">
					<Icon n="minus" />
				</button>
				<span class="mono fsz">{font}</span>
				<button class="iconbtn" onClick={() => changeFont(1)} aria-label="Larger text" title="Larger text">
					<Icon n="plus" />
				</button>
				<button class="iconbtn" onClick={openHistory} aria-label="History and copy" title="History and copy">
					<Icon n="history" />
				</button>
				{conn !== "live" && (
					<button class="iconbtn" onClick={() => api_.current?.reconnect()} aria-label="Reconnect" title="Reconnect">
						<Icon n="refresh" />
					</button>
				)}
			</header>
			{pick && (
				<div class="tpick" onClick={() => setPick(false)}>
					<SessionList s={s} active={name} />
				</div>
			)}
			{(sharedNote || fit) && (
				<div class="sharebar">
					{fit ? (
						<>
							<span>This screen sets the size{grid?.by ? `; ${grid.by} sees it smaller` : ""}.</span>
							<button class="btn sm" onClick={toggleFit}>
								Give it back
							</button>
						</>
					) : (
						<>
							<span>
								{cap(grid?.by ?? "another client")} is attached at {grid?.cols}×{grid?.rows}. Shown at its size so it isn't squeezed.
							</span>
							<button class="btn sm" onClick={toggleFit}>
								<Icon n="fit" size={14} /> Fit here
							</button>
						</>
					)}
				</div>
			)}
			<div class="xwrap">
				<div class="xhost" ref={host} />
				{err && <div class="xerr">{err}</div>}
				{conn === "closed" && (
					<div class="xover">
						<p>The session ended or detached.</p>
						<button class="btn" onClick={() => api_.current?.reconnect()}>
							Reconnect
						</button>
					</div>
				)}
				{toast && <div class="toast">{toast}</div>}
			</div>
			<div class="keybar" onPointerDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}>
				<button onClick={() => api_.current?.key("\x1b")}>Esc</button>
				<button onClick={() => api_.current?.key("\t")}>Tab</button>
				<button class={ctrl ? "on" : ""} aria-pressed={ctrl} onClick={() => setCtrl(!ctrl)}>
					Ctrl
				</button>
				<button onClick={() => api_.current?.key("\x03")} title="Ctrl+C">
					^C
				</button>
				<button aria-label="Left" onClick={() => arrow("D")}>
					<Icon n="back" size={16} />
				</button>
				<button aria-label="Up" onClick={() => arrow("A")}>
					<Icon n="up" size={16} />
				</button>
				<button aria-label="Down" onClick={() => arrow("B")}>
					<Icon n="down" size={16} />
				</button>
				<button aria-label="Right" onClick={() => arrow("C")}>
					<Icon n="right" size={16} />
				</button>
				<button aria-label="Enter" onClick={() => api_.current?.key("\r")}>
					<Icon n="enter" size={16} />
				</button>
				<button class={compose ? "on" : ""} aria-label="Type a line" title="Type a line (keeps autocorrect and dictation)" onClick={() => setCompose(!compose)}>
					<Icon n="type" size={16} />
				</button>
			</div>
			{compose && (
				<form
					class="compose"
					onSubmit={(e) => {
						e.preventDefault();
						api_.current?.paste(line, true);
						setLine("");
					}}
				>
					<input
						class="txt"
						value={line}
						placeholder={`Type into ${name}…`}
						enterkeyhint="send"
						autocomplete="off"
						onInput={(e) => setLine((e.target as HTMLInputElement).value)}
					/>
					<button type="button" class="btn" disabled={!line} title="Insert without Enter" onClick={() => (api_.current?.paste(line, false), setLine(""))}>
						Insert
					</button>
					<button class="btn go" aria-label="Send with Enter">
						<Icon n="enter" size={16} />
					</button>
				</form>
			)}
			{hist !== null && (
				<div class="history">
					<header class="vh">
						<h1>History · {name}</h1>
						<span class="sp" />
						<button class="btn sm" onClick={() => void copyText(hist).then((ok) => (api_.current as any)?.flash?.(ok ? "copied all" : "select and copy by hand"))}>
							<Icon n="copy" size={14} /> Copy all
						</button>
						<button class="iconbtn" onClick={() => setHist(null)} aria-label="Close">
							<Icon n="x" />
						</button>
					</header>
					<pre
						ref={(el) => {
							if (el && hist) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
						}}
					>{hist || "loading…"}</pre>
				</div>
			)}
		</div>
	);
}
