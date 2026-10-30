/**
 * No role yet: any pi with perch loaded announces itself in PERCH_HOME/present/ so the
 * dashboard can offer "adopt". Adopting turns this running session into a worker in place,
 * without a restart and without losing its conversation.
 */
import { readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BOSS, NAME_RE, p, type Presence, readJson, rememberRole, userName, writeJson } from "./store.ts";
import { ownSession } from "./tmux.ts";
import { worker } from "./worker.ts";

/** Subagents are pi processes started by another pi. */
function parentIsPi() {
	try {
		return readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim() === "pi";
	} catch {
		return false;
	}
}

export function dormant(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let tmux: string | undefined;
	let started = Date.now();
	let ticks = 0;

	const announce = () => {
		if (!ctx || !tmux) return;
		const me: Presence = {
			pid: process.pid,
			tmux,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionName: pi.getSessionName(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			started,
		};
		writeJson(p.presence(process.pid), me);
	};
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		rmSync(p.presence(process.pid), { force: true });
	};

	function check() {
		const req = readJson<{ name: string }>(p.adopt(process.pid));
		if (!req) {
			if (++ticks % 20 === 0) announce(); // keep cwd/session/model current
			return;
		}
		rmSync(p.adopt(process.pid), { force: true });
		const name = String(req.name);
		if (!ctx || !NAME_RE.test(name) || name === BOSS) return;
		stop();
		rememberRole({ role: "worker", name });
		const rt = worker(pi, name);
		rt.start(ctx);
		rt.deliver(
			`[boss] ${userName()} has put this session under perch as worker "${name}"; your Perch instructions are now in your system prompt. ` +
				`Write a short brief of your current task to ${p.brief(name)} (goal, where the work lives, what done looks like), ` +
				"then call report with a headline and a milestone plan for where you are now, and carry on with your work.",
		);
	}

	pi.on("session_start", (_e, c) => {
		ctx = c;
		started = Date.now();
		tmux = ownSession();
		if (!tmux || parentIsPi()) return; // only top-level pi sessions in tmux can be adopted
		announce();
		timer ??= setInterval(check, 3000);
	});
	const remember = (_e: unknown, c: ExtensionContext) => {
		ctx = c;
	};
	pi.on("agent_start", remember);
	pi.on("agent_settled", remember);
	pi.on("session_shutdown", stop);
}
