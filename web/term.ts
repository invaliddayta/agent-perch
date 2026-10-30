/**
 * Browser terminals: xterm.js in the page, a PTY running `tmux attach` here.
 *
 * Each connection attaches through its own grouped "viewer" session (__perch_view_*), so it
 * gets its own current window, status bar and mouse setting without touching the real session.
 *
 * Sizing. A tmux window has one size. Rule: a viewer never shrinks someone else's view unless
 * asked to. While another client is sizing the window (a laptop, another browser), this one
 * attaches with ignore-size and shows the window at that client's size; the page scales it down.
 * When nobody else is attached, it fits the window to the browser. "Fit here" (mode "fit")
 * takes the size over explicitly; tmux's window-size=latest then follows whoever types.
 *
 * Wire: binary frames are terminal output; text frames are JSON control messages.
 *   page -> here: {t:"in",d} {t:"size",cols,rows} {t:"mode",mode:"auto"|"fit"|"passive"} {t:"ping"}
 * A hidden page goes passive, so a phone in a pocket never decides anyone's window size.
 *   here -> page: {t:"grid",cols,rows,shared,by} {t:"error",message} {t:"pong"}
 */
import type { ServerWebSocket, Subprocess } from "bun";
import { tmux } from "../ext/tmux.ts";

export const VIEW_PREFIX = "__perch_view_";
const socketArgs = () => (process.env.PERCH_TMUX_SOCKET ? ["-L", process.env.PERCH_TMUX_SOCKET] : []);

export interface TermData {
	target: string;
	mode: "auto" | "fit" | "passive"; // passive: tab hidden, never size the window
	cols: number; // what fits the browser
	rows: number;
	viewer?: string;
	client?: string; // our tmux client name (the PTY path)
	shared?: boolean;
	grid?: [number, number];
	by?: string;
	proc?: Subprocess;
	timer?: ReturnType<typeof setInterval>;
	closed?: boolean;
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
	const v = Math.floor(Number(n));
	return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : dflt;
};

/** Viewer sessions of open websockets. Any other viewer is a leftover. */
const live = new Set<string>();

/** Kill leftover viewer sessions: all of them at startup, later the ones no open websocket owns. */
export function reapViewers(all = true) {
	const r = tmux("list-sessions", "-F", "#{session_name}\t#{session_created}");
	if (!r.ok) return;
	const now = Date.now() / 1000;
	for (const [name, created] of r.out.split("\n").map((l) => l.split("\t"))) {
		if (!name?.startsWith(VIEW_PREFIX) || live.has(name)) continue;
		if (all || now - Number(created) > 20) tmux("kill-session", "-t", `=${name}`);
	}
}
setInterval(() => reapViewers(false), 30_000).unref();

export function termData(url: URL): TermData | string {
	const target = url.searchParams.get("session") ?? "";
	if (!target || target.startsWith("__") || /[\x00-\x1f:]/.test(target)) return "bad session";
	if (!tmux("has-session", "-t", `=${target}`).ok) return `no tmux session named ${target}`;
	return {
		target,
		mode: (["fit", "passive"].includes(url.searchParams.get("mode") ?? "") ? url.searchParams.get("mode") : "auto") as TermData["mode"],
		cols: clamp(url.searchParams.get("cols"), 20, 400, 80),
		rows: clamp(url.searchParams.get("rows"), 5, 200, 24),
	};
}

/** Other clients that currently size the target's windows (same session group, not ignore-size). */
function sizers(d: TermData): string[] {
	const group = tmux("display-message", "-p", "-t", `=${d.target}:`, "#{session_group}").out || d.target;
	const r = tmux("list-clients", "-F", "#{client_name}\t#{client_session}\t#{session_group}\t#{client_flags}\t#{client_termname}");
	if (!r.ok) return [];
	const out: string[] = [];
	for (const line of r.out.split("\n").filter(Boolean)) {
		const [name, session, grp, flags] = line.split("\t");
		if (name === d.client) continue;
		if (session !== d.target && (grp || session) !== group) continue;
		if (flags.split(",").includes("ignore-size")) continue;
		out.push(session.startsWith(VIEW_PREFIX) ? "another browser" : "a terminal");
	}
	return out;
}

function windowSize(d: TermData): [number, number] | undefined {
	const r = tmux("display-message", "-p", "-t", `=${d.viewer}:`, "#{window_width} #{window_height}");
	const [w, h] = r.out.split(" ").map(Number);
	return w && h ? [w, h] : undefined;
}

function sendJson(ws: ServerWebSocket<TermData>, msg: unknown) {
	if (!ws.data.closed) ws.send(JSON.stringify(msg));
}

/** Decide shared vs fit, set our client's flags and PTY size, and tell the page. */
function apply(ws: ServerWebSocket<TermData>, force = false) {
	const d = ws.data;
	if (d.closed || !d.proc || !d.client) return;
	const others = d.mode === "fit" ? [] : sizers(d);
	const shared = d.mode === "passive" || others.length > 0;
	if (shared !== d.shared || force) {
		tmux("refresh-client", "-t", d.client, "-f", shared ? "ignore-size" : "!ignore-size");
		d.shared = shared;
	}
	let grid: [number, number] = [d.cols, d.rows];
	if (shared) grid = windowSize(d) ?? grid;
	const by = others[0];
	if (force || !d.grid || grid[0] !== d.grid[0] || grid[1] !== d.grid[1] || by !== d.by) {
		d.grid = grid;
		d.by = by;
		d.proc.terminal?.resize(grid[0], grid[1]);
		sendJson(ws, { t: "grid", cols: grid[0], rows: grid[1], shared, by: by ?? null });
	}
}

export async function openTerm(ws: ServerWebSocket<TermData>) {
	const d = ws.data;
	try {
		const viewer = `${VIEW_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
		const made = tmux("new-session", "-d", "-s", viewer, "-t", `=${d.target}`);
		if (!made.ok) throw new Error(made.err || "could not create a viewer session");
		d.viewer = viewer;
		live.add(viewer);
		// Viewer-only options: no status bar (rows are precious on a phone), wheel/touch scrolls
		// into copy mode, and (below) the viewer disappears with its last client even if we crash.
		// (set-option and display-message take a pane target: "=name:" is that session's current pane.)
		tmux("set-option", "-t", `=${viewer}:`, "status", "off");
		tmux("set-option", "-t", `=${viewer}:`, "mouse", "on");
		if (d.closed) return closeTerm(ws);

		const startShared = d.mode === "passive" || (d.mode !== "fit" && sizers(d).length > 0);
		d.proc = Bun.spawn(["tmux", ...socketArgs(), "attach-session", ...(startShared ? ["-f", "ignore-size"] : []), "-t", `=${viewer}`], {
			env: { ...process.env, TMUX: "", TERM: "xterm-256color", COLORTERM: "truecolor" },
			terminal: {
				cols: d.cols,
				rows: d.rows,
				data(_t, bytes) {
					if (!d.closed) ws.sendBinary(bytes);
				},
			},
			onExit() {
				if (!d.closed) ws.close(1000, "detached");
			},
		});
		// Find our client (its tty) so flags and sizes target only us.
		for (let i = 0; i < 40 && !d.client && !d.closed; i++) {
			const r = tmux("list-clients", "-t", `=${viewer}`, "-F", "#{client_name}");
			if (r.ok && r.out) d.client = r.out.split("\n")[0];
			else await Bun.sleep(50);
		}
		if (!d.client) throw new Error("tmux client did not attach");
		// Only now (an unattached session would go at once): the viewer goes with its last client.
		tmux("set-option", "-t", `=${viewer}:`, "destroy-unattached", "on");
		d.shared = startShared;
		apply(ws, true);
		d.timer = setInterval(() => {
			// The session was closed: our grouped viewer would keep its windows alive. Let them go.
			if (!tmux("has-session", "-t", `=${d.target}`).ok) {
				sendJson(ws, { t: "error", message: `The tmux session ${d.target} has ended.` });
				ws.close(1000, "session ended");
				return;
			}
			apply(ws);
		}, 1500);
	} catch (e) {
		sendJson(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
		ws.close(1011, "attach failed");
	}
}

export function termMessage(ws: ServerWebSocket<TermData>, raw: string | Buffer) {
	const d = ws.data;
	if (d.closed) return;
	let msg: any;
	try {
		msg = JSON.parse(String(raw));
	} catch {
		return;
	}
	switch (msg.t) {
		case "in":
			if (typeof msg.d === "string" && msg.d.length <= 65536) d.proc?.terminal?.write(msg.d);
			return;
		case "size":
			d.cols = clamp(msg.cols, 20, 400, d.cols);
			d.rows = clamp(msg.rows, 5, 200, d.rows);
			return apply(ws, true);
		case "mode":
			d.mode = msg.mode === "fit" || msg.mode === "passive" ? msg.mode : "auto";
			return apply(ws, true);
		case "ping":
			return sendJson(ws, { t: "pong" });
	}
}

export function closeTerm(ws: ServerWebSocket<TermData>) {
	const d = ws.data;
	d.closed = true;
	if (d.timer) clearInterval(d.timer);
	try {
		d.proc?.terminal?.close();
	} catch {}
	d.proc?.kill();
	if (d.viewer) {
		live.delete(d.viewer);
		tmux("kill-session", "-t", `=${d.viewer}`);
	}
}

/** Recent pane text (scrollback included) for reading and copying on a phone. */
export function history(target: string, lines = 3000): string | undefined {
	if (!target || target.startsWith("__")) return undefined;
	const r = tmux("capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", `=${target}:`);
	return r.ok ? r.out.replace(/\s+$/, "") : undefined;
}
