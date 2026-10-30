/**
 * One-tap adopt for a pi that runs without perch: type /reload into it (which loads the global
 * perch extension in dormant mode), wait for it to announce itself, then adopt it.
 *
 * Typing into someone's terminal is only safe when that pi is idle and its editor is empty,
 * so we read the screen first. pi draws its editor between two full-width rules; while it
 * works, the top rule carries the spinner ("── ⠇ Working ───").
 */
import { readdirSync, readFileSync } from "node:fs";
import { tmux } from "../ext/tmux.ts";

export type Check = { ok: true; pane: string } | { ok: false; why: string };

const RULE = /^─{8,}$/;

export function editorState(screen: string): "idle" | "busy" | "typed" | "unknown" {
	const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
	let bottom = -1;
	for (let i = lines.length - 1; i >= 0; i--)
		if (RULE.test(lines[i])) {
			bottom = i;
			break;
		}
	if (bottom < 1) return "unknown";
	let top = -1;
	for (let i = bottom - 1; i >= 0; i--)
		if (lines[i].startsWith("─")) {
			top = i;
			break;
		}
	if (top < 0 || bottom - top > 30) return "unknown";
	if (!RULE.test(lines[top])) return "busy";
	return lines.slice(top + 1, bottom).some((l) => l.trim()) ? "typed" : "idle";
}

export interface Procs {
	kids: Map<number, number[]>;
	comm: Map<number, string>;
}

/** Parent/child links and names of all processes, from /proc. */
export function procs(): Procs {
	const kids = new Map<number, number[]>();
	const comm = new Map<number, string>();
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const st = readFileSync(`/proc/${d}/stat`, "utf8");
			const close = st.lastIndexOf(")");
			const ppid = Number(st.slice(close + 2).split(" ")[1]);
			comm.set(Number(d), st.slice(st.indexOf("(") + 1, close));
			kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
		} catch {}
	}
	return { kids, comm };
}

/** The pid of a pi running under a process (the nearest one), e.g. under the shell of a tmux pane. */
export function piUnder(root: number, { kids, comm }: Procs = procs()): number | undefined {
	let level = [root];
	for (let depth = 0; depth < 6 && level.length; depth++) {
		const hit = level.find((pid) => comm.get(pid) === "pi");
		if (hit) return hit;
		level = level.flatMap((pid) => kids.get(pid) ?? []);
	}
}

export function checkPi(session: string): Check {
	const r = tmux("list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_in_mode}\t#{pane_dead}\t#{pane_pid}");
	if (!r.ok) return { ok: false, why: "that tmux session is gone" };
	// A pi started by a script (perch's run.sh) shows as bash: look at the processes too.
	const panes = r.out
		.split("\n")
		.map((l) => l.split("\t"))
		.filter(([, cmd, , dead, pid]) => dead !== "1" && (cmd === "pi" || !!piUnder(Number(pid))));
	if (panes.length !== 1) return { ok: false, why: panes.length ? "it runs more than one pi" : "no pi is running in it" };
	const [pane, , inMode] = panes[0];
	if (inMode === "1") return { ok: false, why: "its terminal is scrolled back (tmux copy mode); press Esc in it first" };
	const screen = tmux("capture-pane", "-p", "-t", pane);
	if (!screen.ok) return { ok: false, why: "could not read its screen" };
	switch (editorState(screen.out)) {
		case "idle":
			return { ok: true, pane };
		case "busy":
			return { ok: false, why: "pi is working; try again when it is idle" };
		case "typed":
			return { ok: false, why: "there is unsent text in its editor" };
		default:
			return { ok: false, why: "pi's editor is not showing (a menu or dialog may be open)" };
	}
}

/** Type /reload into the pi of a tmux session, only if that is safe right now. */
export function reloadPi(session: string): Check {
	const c = checkPi(session);
	if (!c.ok) return c;
	tmux("send-keys", "-t", c.pane, "-l", "/reload");
	tmux("send-keys", "-t", c.pane, "Enter");
	return c;
}
