/** Live dashboard state (one SSE stream) and the small JSON API. */
import { useEffect, useState } from "preact/hooks";

export type State = "working" | "idle" | "asking" | "done" | "error" | "stopped" | "dead";
export type Shown = State | "needs";

export interface Status {
	name: string;
	role: "boss" | "worker";
	state: State;
	headline: string;
	milestones: string[];
	completed: number;
	started: number;
	updated: number;
	heartbeat: number;
	pid: number;
	tmux?: string;
	model?: string;
	thinking?: string;
	cost: number;
	tokens: number;
	context?: number;
	activity: number[];
	activityAt: number;
	pending: string[];
	error?: string;
}
export interface Question {
	id: string;
	ts: number;
	worker?: string;
	question: string;
	options?: string[];
	context?: string;
}
export interface ChatLine {
	ts: number;
	from: "user" | "boss" | "act";
	text: string;
	worker?: string;
	via?: string;
	ref?: string;
	images?: string[];
}
export interface Presence {
	pid: number;
	tmux?: string;
	cwd: string;
	sessionName?: string;
	model?: string;
}
export interface Unmanaged {
	name: string;
	command: string;
	path: string;
	activity: number;
	created: number;
	adoptable: Presence[];
	pending?: { name: string; since: number; error?: string };
}
export interface Snapshot {
	now: number;
	home: string;
	/** This machine's name. */
	host?: string;
	/** What the boss calls the user (settings, or the OS account). */
	user?: string;
	/** The deployed commit. */
	version?: string;
	boss: Status | null;
	bossTmux: boolean;
	workers: Status[];
	questions: Question[];
	chat: ChatLine[];
	unmanaged: Unmanaged[];
	timeline: Record<string, [number, number, string][]>;
	window: number;
	gpu?: { util: number; used: number; total: number; name: string };
	/** CPU % (all cores), memory and swap in GiB. */
	machine?: { cpu: number; cores: number; mem: { used: number; total: number }; swap: { used: number; total: number } };
	/** The dashboard's HTTPS address, once it has a certificate (the mic needs it). */
	secureUrl?: string;
}

let snap: Snapshot | null = null;
let skew = 0;
let online = false;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export const now = () => Date.now() + skew;
export const isOnline = () => online;

function connect() {
	const es = new EventSource("/api/events");
	es.addEventListener("state", (e) => {
		snap = JSON.parse((e as MessageEvent).data);
		skew = snap!.now - Date.now();
		online = true;
		notify();
	});
	es.onerror = () => {
		online = false;
		notify();
	};
}
connect();
// Ages ("3m ago") move even when nothing else does.
setInterval(notify, 15_000);

export function useSnap(): Snapshot | null {
	const [, set] = useState(0);
	useEffect(() => {
		const f = () => set((n) => n + 1);
		subs.add(f);
		return () => void subs.delete(f);
	}, []);
	return snap;
}

export async function api<T = any>(path: string, data?: unknown): Promise<T & { error?: string }> {
	try {
		const r = await fetch(path, {
			method: data === undefined ? "GET" : "POST",
			headers: { "content-type": "application/json" },
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		const text = await r.text();
		try {
			return JSON.parse(text);
		} catch {
			return { error: text || `HTTP ${r.status}` } as T & { error: string };
		}
	} catch (e) {
		return { error: `offline: ${e instanceof Error ? e.message : e}` } as T & { error: string };
	}
}

export const shown = (s: Snapshot, w: Status): Shown => (s.questions.some((q) => q.worker === w.name) ? "needs" : w.state);

export const ORDER: Shown[] = ["needs", "dead", "error", "asking", "working", "idle", "done", "stopped"];
export const LABEL: Record<Shown, string> = {
	working: "working",
	asking: "asking boss",
	needs: "needs you",
	idle: "idle",
	done: "done",
	error: "error",
	dead: "dead",
	stopped: "stopped",
};

export function sortedWorkers(s: Snapshot): Status[] {
	return [...s.workers].sort((a, b) => ORDER.indexOf(shown(s, a)) - ORDER.indexOf(shown(s, b)) || b.updated - a.updated);
}

export function bossRunning(s: Snapshot) {
	return !!(s.bossTmux && s.boss && s.boss.state !== "stopped" && s.boss.state !== "dead");
}
