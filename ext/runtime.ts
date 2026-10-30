/**
 * What boss and workers share: keep status.json current, watch the inbox, track cost and
 * activity, and follow model changes made on the settings page.
 */
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ownSession } from "./tmux.ts";
import { appendJsonl, drain, imageContent, type ModelChoice, type Msg, p, readStatus, type State, type Status, writeJson } from "./store.ts";

const BUCKET = 5 * 60_000;
const BUCKETS = 12;

export interface Hooks {
	/** A message arrived in the inbox. */
	handle(msg: Msg): void;
	/** The agent stopped and pi will not continue on its own. */
	settled(info: { aborted: boolean; text: string; error?: string }): void;
	/** The model this agent should use according to settings, if settings decide it. */
	desiredModel(): ModelChoice | undefined;
	/** The agent's own system prompt section. */
	prompt(): string;
	/** Session start, after status is set up. */
	started?(ctx: ExtensionContext): void;
	/** Each completed user/assistant message (raw pi message). */
	message?(msg: any): void;
}

export const textOf = (message: any): string =>
	typeof message?.content === "string"
		? message.content
		: Array.isArray(message?.content)
			? message.content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("\n")
			: "";

const SIGNAL = Symbol.for("perch.signal");
/** The signal that is shutting this pi down, if any (listening once per process, across reloads). */
function signalled(): string | undefined {
	return (globalThis as any)[SIGNAL]?.got;
}
/**
 * Also notes the signal in status.json right away (via the current runtime's `now`): a pi that is
 * busy drawing when its terminal goes may exit on the first failed write (pi's emergency exit, code
 * 129), before session_shutdown gets to it, or even before the SIGHUP is dispatched. That exit
 * counts as SIGHUP too: the terminal went away.
 */
function listenForSignals(): { got?: string; now?: (sig: string) => void } {
	const had = (globalThis as any)[SIGNAL];
	if (had) return had;
	const box: { got?: string; now?: (sig: string) => void } = {};
	(globalThis as any)[SIGNAL] = box;
	for (const sig of ["SIGTERM", "SIGHUP"] as const)
		process.prependListener(sig, () => {
			if (box.got) return;
			box.got = sig;
			try {
				box.now?.(sig);
			} catch {}
		});
	process.on("exit", (code) => {
		if (code !== 129 || box.got) return;
		box.got = "SIGHUP";
		try {
			box.now?.("SIGHUP");
		} catch {}
	});
	return box;
}

export function runtime(pi: ExtensionAPI, name: string, role: "boss" | "worker", hooks: Hooks) {
	const signals = listenForSignals();
	let ctx: ExtensionContext | undefined;
	let status: Status | undefined;
	let lastSave = 0;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let timers: ReturnType<typeof setInterval>[] = [];
	let watcher: FSWatcher | undefined;
	let draining = false;
	let lastApplied = "";
	let lastAssistant: any;

	const now = () => Date.now();

	function save(force = false) {
		if (!status) return;
		const t = now();
		if (!force && t - lastSave < 2000) {
			saveTimer ??= setTimeout(() => {
				saveTimer = undefined;
				save(true);
			}, 2000);
			return;
		}
		lastSave = t;
		status.heartbeat = t;
		writeJson(p.status(name), status);
	}

	function update(patch: Partial<Status>, force = true) {
		if (!status) return;
		const before = `${status.state}\u0000${status.headline}`;
		Object.assign(status, patch);
		const after = `${status.state}\u0000${status.headline}`;
		if (before !== after) appendJsonl(p.events(name), { ts: now(), state: status.state, headline: status.headline });
		if (patch.state || patch.headline || patch.milestones || patch.completed !== undefined) status.updated = now();
		save(force);
	}

	const setState = (state: State, extra: Partial<Status> = {}) => update({ state, ...extra });
	signals.now = (sig) => {
		if (status && status.state !== "stopped") update({ signal: sig });
	};

	function roll(n = 0) {
		if (!status) return;
		const shift = Math.min(BUCKETS, Math.floor(now() / BUCKET) - Math.floor(status.activityAt / BUCKET));
		if (shift > 0) status.activity = [...status.activity.slice(shift), ...Array(shift).fill(0)];
		status.activityAt = now();
		status.activity[BUCKETS - 1] += n;
	}

	/** Inject a user message. Images (file paths) go along as real image content, so the model sees them. */
	function deliver(text: string, urgent = false, images: string[] = []) {
		if (!ctx) return;
		let content: Parameters<typeof pi.sendUserMessage>[0] = text;
		if (images.length) {
			const parts = images.map((f) => ({ f, c: imageContent(f) }));
			const missing = parts.filter((x) => !x.c).map((x) => x.f);
			content = [
				{ type: "text", text: missing.length ? `${text}\n(could not read: ${missing.join(", ")})` : text },
				...parts.flatMap((x) => (x.c ? [x.c] : [])),
			];
		}
		try {
			if (ctx.isIdle()) pi.sendUserMessage(content);
			else pi.sendUserMessage(content, { deliverAs: urgent ? "steer" : "followUp" });
		} catch {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		}
	}

	function pump() {
		if (draining || !ctx) return;
		draining = true;
		try {
			for (const msg of drain(name)) {
				try {
					hooks.handle(msg);
				} catch (e) {
					ctx.ui.notify(`perch: could not handle ${msg.kind} from ${msg.from}: ${e}`, "error");
				}
			}
		} finally {
			draining = false;
		}
	}

	const modelKey = (c?: ModelChoice) => (c ? `${c.model}\u0000${c.thinking}` : "");

	async function syncModel() {
		const want = hooks.desiredModel();
		const key = modelKey(want);
		if (!want || !ctx || key === lastApplied) return;
		lastApplied = key;
		// Empty means pi's own default: leave whatever pi runs with.
		if (want.model) {
			const [provider, ...rest] = want.model.split("/");
			const model = ctx.modelRegistry.find(provider, rest.join("/"));
			if (model && (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)) {
				const ok = await pi.setModel(model);
				if (!ok) ctx.ui.notify(`perch: no credentials for ${want.model}`, "warning");
			}
		}
		if (want.thinking && pi.getThinkingLevel() !== want.thinking) pi.setThinkingLevel(want.thinking as any);
	}

	/** Set up status and the inbox. Runs at session start, or later when a running pi is adopted. */
	function start(c: ExtensionContext) {
		ctx = c;
		const prev = readStatus(name);
		let cost = 0;
		let tokens = 0;
		for (const entry of c.sessionManager.getEntries() as any[]) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				cost += entry.message.usage?.cost?.total ?? 0;
				tokens += entry.message.usage?.totalTokens ?? 0;
			}
		}
		const t = now();
		status = {
			name,
			role,
			// After a /reload (same process) a finished worker stays done.
			state: prev?.pid === process.pid && prev.state === "done" ? "done" : "idle",
			headline: prev?.headline ?? (role === "boss" ? "ready" : "starting"),
			milestones: prev?.milestones ?? [],
			completed: prev?.completed ?? 0,
			started: t,
			updated: t,
			heartbeat: t,
			pid: process.pid,
			tmux: ownSession(),
			model: c.model ? `${c.model.provider}/${c.model.id}` : undefined,
			thinking: pi.getThinkingLevel(),
			cost,
			tokens,
			activity: prev?.activity?.length === BUCKETS ? prev.activity : Array(BUCKETS).fill(0),
			activityAt: prev?.activityAt ?? t,
			pending: prev?.pending ?? [],
			sessionFile: c.sessionManager.getSessionFile(),
		};
		roll();
		lastApplied = modelKey(hooks.desiredModel());
		hooks.started?.(c);
		appendJsonl(p.events(name), { ts: t, state: status.state, headline: status.headline });
		save(true);

		mkdirSync(p.inbox(name), { recursive: true });
		try {
			watcher = watch(p.inbox(name), () => setTimeout(pump, 50));
		} catch {
			/* polling below still works */
		}
		// Let pi finish starting before injecting anything that waited in the inbox.
		timers.push(setTimeout(pump, 1500) as any);
		timers.push(setInterval(pump, 2000));
		timers.push(
			setInterval(() => {
				roll();
				save(true);
			}, 15_000),
		);
	}

	pi.on("session_start", (_e, c) => start(c));

	pi.on("session_shutdown", async (e) => {
		for (const t of timers) clearInterval(t);
		timers = [];
		watcher?.close();
		watcher = undefined;
		if (saveTimer) clearTimeout(saveTimer);
		ctx = undefined;
		// pi also shuts down cleanly on SIGTERM/SIGHUP (the machine shutting down, its tmux session
		// killed). Nobody asked for that stop: leave the state alone and note the signal, so the
		// dashboard shows it dead, with Resume, once the process is gone. The signal listener may run
		// after pi's own, so look once the signal has been dispatched.
		await new Promise((r) => setImmediate(r));
		const sig = signalled();
		if (!status || e.reason === "reload") return; // the same process carries on with the reloaded extension
		if (sig && status.state !== "stopped") update({ signal: sig });
		else setState("stopped");
	});

	pi.on("before_agent_start", async (e, c) => {
		ctx = c;
		await syncModel();
		const section = hooks.prompt();
		if (section) e.systemPromptOptions.sections.perch = section;
	});

	pi.on("agent_start", (_e, c) => {
		ctx = c;
		lastAssistant = undefined;
		if (status && status.state !== "working") setState("working", { error: undefined });
	});

	pi.on("tool_execution_start", () => {
		roll(1);
		save();
	});

	pi.on("message_end", (e, c) => {
		ctx = c;
		const m: any = e.message;
		if (!status || !m) return;
		if (m.role === "assistant") {
			lastAssistant = m;
			status.cost += m.usage?.cost?.total ?? 0;
			status.tokens += m.usage?.totalTokens ?? 0;
			const usage = c.getContextUsage();
			if (usage?.percent != null) status.context = Math.round(usage.percent);
			save();
		}
		if (m.role === "user" || m.role === "assistant") hooks.message?.(m);
	});

	pi.on("model_select", (e) => {
		if (status) update({ model: `${e.model.provider}/${e.model.id}` });
	});
	pi.on("thinking_level_select", (e) => {
		if (status) update({ thinking: e.level });
	});

	pi.on("agent_settled", (e, c) => {
		ctx = c;
		const m = lastAssistant;
		const error = m?.stopReason === "error" ? m.errorMessage || "error" : undefined;
		hooks.settled({ aborted: e.aborted, text: textOf(m), error });
	});

	return {
		name,
		status: () => status,
		ctx: () => ctx,
		update,
		setState,
		deliver,
		pump,
		start,
	};
}
