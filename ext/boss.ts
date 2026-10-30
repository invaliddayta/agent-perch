/**
 * Boss role: the one agent the user talks to. It answers and steers workers, starts new ones,
 * asks the user when it judges a call to be theirs, and explains progress when asked.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { launch, resume } from "./launch.ts";
import { runtime, textOf } from "./runtime.ts";
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	BOSS,
	chat,
	id,
	imageNote,
	imageType,
	MEDIA_RE,
	readJson,
	saveImage,
	listAgents,
	liveStatus,
	loadGuidance,
	loadSettings,
	NAME_RE,
	openQuestions,
	p,
	type Question,
	readJsonl,
	readText,
	type Status,
	send,
	userName,
	writeJson,
	writeText,
} from "./store.ts";
import { hasSession, tmux } from "./tmux.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

const ago = (ms: number) => {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Messages perch injects, by prefix ("[<user>] ...", "[<worker> asks ...]"). Anything else is the
// user typing into the boss terminal.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fromUserChat = (text: string, user: string) => new RegExp(`^\\[${esc(user)}( tapped [^\\]]+)?\\]`).test(text);
const fromPerch = (text: string, user: string) =>
	new RegExp(`^\\[(${esc(user)} answers |[a-z0-9][a-z0-9-]* (asks|stopped|finished|failed|adopted)\\b)`).test(text);

export function workerTable(): string {
	const workers = listAgents()
		.filter((n) => n !== BOSS)
		.map(liveStatus)
		.filter((s): s is Status => !!s);
	const questions = openQuestions();
	if (!workers.length) return "(no workers yet)";
	return workers
		.map((s) => {
			const qs = questions.filter((q) => q.worker === s.name);
			const ms = s.milestones.length ? ` · ${s.completed}/${s.milestones.length} (next: ${s.milestones[s.completed] ?? "-"})` : "";
			const extra = [
				s.pending.length ? `waiting on you for ${s.pending.join(", ")}` : "",
				qs.length ? `${userName()} asked: ${qs.map((q) => q.id).join(", ")}` : "",
				s.error ? `error: ${cut(s.error, 120)}` : "",
			]
				.filter(Boolean)
				.join("; ");
			return `- ${s.name}: ${s.state} · ${s.headline}${ms} · updated ${ago(s.updated)} ago · $${s.cost.toFixed(2)} · ${s.model ?? "?"}${extra ? ` · ${extra}` : ""}`;
		})
		.join("\n");
}

/** The last messages of a worker's session, compact enough for the boss's context. */
export function transcript(file: string | undefined, n: number): string {
	if (!file) return "(no session file)";
	const entries = readJsonl<any>(file).filter(
		(e) => e.type === "message" && ["user", "assistant", "toolResult"].includes(e.message?.role),
	);
	const out: string[] = [];
	for (const e of entries.slice(-n)) {
		const m = e.message;
		const when = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 16) : "";
		if (m.role === "user") out.push(`[${when}] USER: ${cut(textOf(m), 700)}`);
		else if (m.role === "assistant") {
			const t = textOf(m).trim();
			if (t) out.push(`[${when}] WORKER: ${cut(t, 1200)}`);
			for (const c of m.content ?? []) {
				if (c.type === "toolCall") out.push(`  → ${c.name} ${cut(JSON.stringify(c.arguments ?? {}), 220)}`);
			}
			if (m.stopReason === "error") out.push(`  ✗ error: ${cut(m.errorMessage ?? "", 300)}`);
		} else {
			const t = textOf(m).trim().split("\n");
			out.push(`  ${m.isError ? "✗" : "←"} ${cut(t[0] ?? "", 200)}${t.length > 1 ? ` (+${t.length - 1} lines)` : ""}`);
		}
	}
	return out.join("\n") || "(empty)";
}

/** Reminder under the user's chat messages while questions to them are open: they often answer in the chat. */
function openNote(): string {
	const qs = openQuestions();
	if (!qs.length) return "";
	const list = qs.map((q) => `${q.id} "${cut(q.question, 80)}"`).join(", ");
	return `\n(Open questions to ${userName()}: ${list}. If this message answers one or makes it moot, call close_question for it.)`;
}

const hasImages = (m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "image");

/** Images the user pasted into the boss terminal, saved so the chat can show them too. */
function terminalImages(m: any): string[] | undefined {
	if (!hasImages(m)) return;
	return m.content
		.filter((c: any) => c?.type === "image" && typeof c.data === "string")
		.map((c: any) => saveImage(Buffer.from(c.data, "base64"), c.mimeType));
}

export function boss(pi: ExtensionAPI) {
	let userWaiting = false; // a message from the user is in the conversation and not answered yet
	let tapped: string | undefined; // worker the user tapped, so the reply can be shown on its card
	let widgetTimer: ReturnType<typeof setInterval> | undefined;

	const rt = runtime(pi, BOSS, "boss", {
		prompt: () => {
			const u = userName();
			return `## Perch
You are the boss of ${u}'s perch. Several pi workers, each an interactive pi in its own tmux session, work on ${u}'s projects in parallel. ${u} talks only to you. You keep the workers moving: answer their questions, unblock and correct them, check their work, and start new workers when ${u} wants something done. You have the normal tools too: read any worker's files, run commands, look at results yourself before you answer.

Messages reach you as user messages:
- "[${u}] ..." is ${u} in the dashboard chat. Your final reply is shown there. Talk like a colleague: short, concrete, no filler. If images were sent, you see them in the message, and a last line "[image attached: <path>]" names their files; to pass one to a worker, put that path in \`tell\`'s images.
- "[${u} tapped <worker>]" means ${u} wants to know where that worker stands. Use the table below and \`peek\` if needed. Answer in 2-5 sentences: progress, what it is doing now, anything blocking or worth knowing.
- "[${u} answers <qid> about <worker>] ..." is the answer to a question you asked. Pass it to the worker with \`answer\` (if the worker asked) or \`tell\`, in your own words with the context it needs.
- Open questions to ${u} show as cards on the dashboard until they are closed. When ${u} answers one in the chat instead of with its buttons, or one becomes moot, close it at once with \`close_question\`, then act on the answer.
- "[<worker> asks <qid>] ..." is a worker's question. Answer it yourself with \`answer\` whenever you can; check files or peek first if that helps. Use \`ask_user\` only when you judge the call to be ${u}'s (see guidance below).
- "[<worker> stopped] ..." means it ended its turn without asking or finishing. Decide: push it on with \`tell\`, review its work, or leave it if it is legitimately waiting. If noProgress is 3 or more, do not push again; find out why, and ask ${u} if you cannot fix it.
- "[<worker> finished] ..." means it reported the task done. Check the result if that is cheap; do not report to ${u} unless asked to.
- "[<worker> failed] ..." means its run ended in an error, often a provider error: tell it to continue if the error looks transient. If it says its pi is gone (killed, crashed, out of memory), bring it back with \`resume\` and tell it what happened, so it does not walk into the same wall.
- "[<worker> adopted] ..." means ${u} put an already running pi session under perch. It writes its own brief and reports; nothing to do unless something looks off.
- Messages without one of these prefixes are ${u} typing directly into your terminal.

Only your replies to ${u}'s own messages reach the chat. After handling worker messages, end with at most one short line; only your terminal shows it. Your tool calls (answer, tell, spawn, ask_user, ...) appear in the chat as one-line activity notes, so write their text so that it reads well there.

${u}'s guidance on when to involve them:
${loadGuidance()}

Starting workers: \`spawn\` with a brief a capable engineer could start cold from: the goal, where the work lives (absolute paths), constraints and ${u}'s rules, what done looks like. Workers start in ${loadSettings().startDir} and find their own way. Their model comes from the settings unless ${u} asked for something else.

Workers right now:
${workerTable()}
${openQuestions().length ? `\nOpen questions to ${u}:\n${openQuestions().map((q) => `- ${q.id} (${q.worker ?? "general"}): ${cut(q.question, 160)}`).join("\n")}` : ""}`;
		},

		desiredModel: () => loadSettings().boss,

		started: (ctx) => {
			writeModels(ctx);
			startWidget(ctx);
		},

		message: (m) => {
			if (m.role === "user") {
				const text = textOf(m).trim();
				const u = userName();
				if (fromUserChat(text, u)) userWaiting = true;
				else if (!fromPerch(text, u) && (text || hasImages(m))) {
					userWaiting = true;
					chat({ from: "user", text, via: "terminal", images: terminalImages(m) });
				}
			} else if (m.role === "assistant" && userWaiting && m.stopReason === "stop") {
				const text = textOf(m).trim();
				if (text) {
					chat({ from: "boss", text, worker: tapped });
					userWaiting = false;
					tapped = undefined;
				}
			}
		},

		handle: (msg) => {
			switch (msg.kind) {
				case "user":
					rt.deliver(`[${userName()}] ${msg.text}${openNote()}`, true, msg.images);
					break;
				case "tap":
					tapped = msg.worker;
					rt.deliver(`[${userName()} tapped ${msg.worker}]`, true);
					break;
				case "user_answer":
					rt.deliver(`[${userName()} answers ${msg.ref} about ${msg.worker ?? "general"}] ${msg.text}`);
					break;
				case "question":
					rt.deliver(`[${msg.from} asks ${msg.ref}] ${msg.text}`);
					break;
				case "settled":
					rt.deliver(`[${msg.from} stopped] noProgress=${(msg.meta?.noProgress as number) ?? 0}. Its last message:\n${msg.text}`);
					break;
				case "done":
					rt.deliver(`[${msg.from} finished] ${msg.text}`);
					break;
				case "error":
					rt.deliver(`[${msg.from} failed] ${msg.text}`);
					break;
				case "adopted":
					rt.deliver(`[${msg.worker} adopted] ${msg.text}`);
					break;
				case "settings": {
					const c = rt.ctx();
					if (c) writeModels(c);
					break;
				}
			}
		},

		settled: ({ error }) => {
			if (error) {
				rt.setState("error", { error });
				if (userWaiting) chat({ from: "boss", text: `I hit an error and stopped: ${cut(error, 300)}` });
			} else rt.setState("idle");
			userWaiting = false;
		},
	});

	function writeModels(ctx: ExtensionContext) {
		const models = ctx.modelRegistry.getAvailable().map((m: any) => ({
			id: `${m.provider}/${m.id}`,
			provider: m.provider,
			name: m.name ?? m.id,
			reasoning: !!m.reasoning,
			thinking: m.reasoning
				? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((l) => l === "off" || m.thinkingLevelMap?.[l] !== null)
				: ["off"],
			contextWindow: m.contextWindow,
		}));
		writeJson(p.models(), { updated: Date.now(), models });
	}

	function startWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const draw = () => {
			const th = ctx.ui.theme;
			const color: Record<string, any> = {
				working: "success",
				asking: "accent",
				idle: "dim",
				done: "accent",
				error: "error",
				dead: "error",
				stopped: "dim",
			};
			const qs = openQuestions();
			const workers = listAgents()
				.filter((n) => n !== BOSS)
				.map(liveStatus)
				.filter((s): s is Status => !!s);
			const width = (process.stdout.columns || 100) - 2;
			const lines = workers.map((s) => {
				const needs = qs.some((q) => q.worker === s.name);
				const state = needs ? "needs you" : s.state;
				const c = needs ? "warning" : color[s.state];
				const ms = s.milestones.length ? ` ${s.completed}/${s.milestones.length}` : "";
				const head = `● ${s.name.padEnd(14)} ${state.padEnd(9)}${ms.padEnd(5)} `;
				return th.fg(c, head) + th.fg("muted", cut(s.headline, Math.max(10, width - head.length)));
			});
			const general = qs.filter((q) => !q.worker).length;
			if (general) lines.push(th.fg("warning", `● ${general} question(s) for ${userName()}`));
			ctx.ui.setWidget("perch", lines.length ? lines : [th.fg("dim", "perch: no workers")]);
		};
		draw();
		widgetTimer = setInterval(draw, 3000);
	}

	pi.on("session_shutdown", () => {
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
	});

	const need = (name: string) => {
		const s = liveStatus(name);
		if (!s || name === BOSS) throw new Error(`no worker named "${name}". Workers: ${listAgents().filter((n) => n !== BOSS).join(", ") || "none"}`);
		return s;
	};

	pi.registerTool({
		name: "workers",
		label: "Workers",
		description: "List all workers with state, headline, milestones, cost and open questions.",
		promptSnippet: "List workers and their current state",
		parameters: Type.Object({}),
		async execute() {
			return ok(workerTable());
		},
	});

	pi.registerTool({
		name: "peek",
		label: "Peek",
		description:
			"Look into a worker: its status, milestones, brief, and the last messages of its session (its own words, tool calls and results).",
		promptSnippet: "Read a worker's status, brief and recent session",
		parameters: Type.Object({
			name: Type.String(),
			messages: Type.Optional(Type.Number({ description: "How many recent messages to show (default 16)." })),
		}),
		async execute(_id, { name, messages }) {
			const s = need(name);
			const ms = s.milestones.map((m, i) => `${i < s.completed ? "✓" : i === s.completed ? "▸" : " "} ${m}`).join("\n");
			return ok(
				[
					`${s.name}: ${s.state} · ${s.headline}`,
					`started ${ago(s.started)} ago · updated ${ago(s.updated)} ago · $${s.cost.toFixed(2)} · context ${s.context ?? "?"}% · ${s.model} ${s.thinking ?? ""} · tmux ${s.tmux ?? "?"}`,
					s.pending.length ? `open questions to you: ${s.pending.join(", ")}` : "",
					ms ? `Milestones:\n${ms}` : "No milestones reported.",
					`Brief (${p.brief(name)}):\n${cut(readText(p.brief(name), "(none)"), 1500)}`,
					`Session tail (${s.sessionFile ?? "?"}):\n${transcript(s.sessionFile, Math.min(60, messages ?? 16))}`,
				]
					.filter(Boolean)
					.join("\n\n"),
			);
		},
	});

	/** Images to pass along: checked, and copied into media/ so the chat can show them. */
	function forwardImages(paths: string[] | undefined): { paths: string[]; names: string[] } {
		const out = { paths: [] as string[], names: [] as string[] };
		for (const f of paths ?? []) {
			const type = imageType(f);
			if (!type) throw new Error(`${f}: not a png, jpg, webp or gif`);
			if (!existsSync(f)) throw new Error(`${f}: no such file`);
			let name = basename(f);
			if (dirname(f) !== p.media().replace(/\/$/, "") || !MEDIA_RE.test(name)) {
				name = `${id("i")}.${f.split(".").pop()!.toLowerCase().replace("jpeg", "jpg")}`;
				copyFileSync(f, p.media(name));
			}
			out.paths.push(p.media(name));
			out.names.push(name);
		}
		return out;
	}
	const imagesParam = Type.Optional(
		Type.Array(Type.String(), {
			description: "Image files to pass along (absolute paths, e.g. from \"[image attached: ...]\"). The worker sees them as images.",
		}),
	);
	const plus = (n: number) => (n ? ` (+${n} image${n > 1 ? "s" : ""})` : "");

	pi.registerTool({
		name: "tell",
		label: "Tell worker",
		description:
			"Send a worker an instruction or information. It arrives as a message starting with [boss]. urgent interrupts its current step instead of waiting until it finishes its run.",
		promptSnippet: "Send a worker an instruction",
		parameters: Type.Object({
			name: Type.String(),
			message: Type.String(),
			urgent: Type.Optional(Type.Boolean()),
			images: imagesParam,
		}),
		async execute(_id, { name, message, urgent, images }) {
			need(name);
			const img = forwardImages(images);
			// The note names the files, so a worker still on older perch code can open them with read.
			send(name, { from: BOSS, kind: "message", text: message + imageNote(img.paths), urgent, images: img.paths });
			chat({ from: "act", worker: name, text: `told ${name}: ${cut(message, 140)}${plus(img.names.length)}`, images: img.names });
			return ok(`Sent to ${name}${plus(img.names.length)}.`);
		},
	});

	pi.registerTool({
		name: "answer",
		label: "Answer worker",
		description: "Answer a worker's question (by its id).",
		promptSnippet: "Answer a worker's question",
		parameters: Type.Object({
			name: Type.String(),
			question_id: Type.String(),
			answer: Type.String(),
			images: imagesParam,
		}),
		async execute(_id, { name, question_id, answer, images }) {
			need(name);
			const img = forwardImages(images);
			send(name, { from: BOSS, kind: "answer", ref: question_id, text: answer + imageNote(img.paths), images: img.paths });
			chat({ from: "act", worker: name, text: `answered ${name}: ${cut(answer, 140)}${plus(img.names.length)}`, ref: question_id, images: img.names });
			return ok(`Answer sent to ${name}.`);
		},
	});

	pi.registerTool({
		name: "close_question",
		label: "Close question",
		description:
			"Close one of your open questions to the user, so its card leaves the dashboard. Use it when they answered in the chat instead of with the card, or when the question became moot.",
		promptSnippet: "Close a question to the user that was answered in chat or is moot",
		parameters: Type.Object({
			question_id: Type.String(),
			summary: Type.String({ description: "The answer in a few words, or why the question is moot." }),
			moot: Type.Optional(Type.Boolean({ description: "true if nobody needs an answer any more." })),
		}),
		async execute(_id, { question_id, summary, moot }) {
			const q = readJson<Question>(p.question(question_id));
			if (!q) throw new Error(`no question ${question_id}. Open: ${openQuestions().map((x) => x.id).join(", ") || "none"}`);
			if (q.answered) return ok(`${question_id} was already closed (${q.answered.how ?? "answered"}: ${cut(q.answered.text, 100)}).`);
			writeJson(p.question(q.id), { ...q, answered: { ts: Date.now(), text: summary, how: moot ? "moot" : "chat" } });
			chat({ from: "act", worker: q.worker, ref: q.id, text: `closed question${q.worker ? ` about ${q.worker}` : ""}: ${cut(summary, 140)}` });
			return ok(`Closed ${question_id}.`);
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask the user",
		description:
			"Put a question to the user on the dashboard. Use it for calls that are theirs to make. Returns at once; the answer arrives later as [<user> answers <id> about <worker>].",
		promptSnippet: "Ask the user a question on the dashboard",
		parameters: Type.Object({
			question: Type.String({ description: "Short and self-contained; often read on a phone." }),
			worker: Type.Optional(Type.String({ description: "The worker it is about, if any." })),
			options: Type.Optional(Type.Array(Type.String(), { description: "2-4 short answer buttons, if the answer is a choice." })),
			context: Type.Optional(Type.String({ description: "One or two sentences of background, your recommendation if you have one." })),
		}),
		async execute(_id, { question, worker, options, context }) {
			if (worker) need(worker);
			const q: Question = { id: id("p"), ts: Date.now(), worker, question, options, context };
			writeJson(p.question(q.id), q);
			chat({ from: "boss", worker, ref: q.id, text: `${worker ? `${worker}: ` : ""}${question}` });
			return ok(`Asked ${userName()} as ${q.id}. The answer arrives as a message. Keep the worker busy with anything that does not depend on it.`);
		},
	});

	pi.registerTool({
		name: "tell_user",
		label: "Tell the user",
		description:
			"Post a message in the user's chat without being asked. Only when they asked to be told about something, or for something they must know now.",
		promptSnippet: "Post an unprompted message in the user's chat",
		parameters: Type.Object({ text: Type.String(), worker: Type.Optional(Type.String()) }),
		async execute(_id, { text, worker }) {
			chat({ from: "boss", worker, text });
			return ok("Posted.");
		},
	});

	pi.registerTool({
		name: "spawn",
		label: "Spawn worker",
		description:
			"Start a new worker: an interactive pi in its own tmux session, started in the start directory from the settings, that reads the brief you write.",
		promptSnippet: "Start a new worker with a brief",
		parameters: Type.Object({
			name: Type.String({ description: "Short lowercase name, also the tmux session name: letters, digits, dashes." }),
			brief: Type.String({
				description: "Markdown brief: goal, where the work lives (absolute paths), constraints and the user's rules, what done looks like.",
			}),
			model: Type.Optional(Type.String({ description: "provider/id, only if the user asked for a specific model." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level, only if the user asked for one." })),
		}),
		async execute(_id, params) {
			const name = params.name.trim();
			if (!NAME_RE.test(name) || name === BOSS) throw new Error("name must be lowercase letters, digits and dashes, and not 'boss'");
			if (hasSession(name)) throw new Error(`a tmux session "${name}" exists already; pick another name`);
			const s = loadSettings();
			const choice = { model: params.model ?? s.worker.model, thinking: params.thinking ?? s.worker.thinking };
			if (params.model || params.thinking) writeJson(p.settings(), { ...s, overrides: { ...s.overrides, [name]: choice } });
			writeText(p.brief(name), `${params.brief.trim()}\n`);
			const r = launch({
				name,
				role: "worker",
				choice,
				startDir: s.startDir,
				prompt: `[boss] Read your brief in ${p.brief(name)} and start.`,
			});
			if (!r.ok) throw new Error(r.error);
			chat({ from: "act", worker: name, text: `started ${name} (${choice.model.split("/").pop() || "default model"}${choice.thinking ? ` · ${choice.thinking}` : ""})` });
			return ok(`Started ${name} in tmux session "${name}". It will report its plan shortly.`);
		},
	});

	pi.registerTool({
		name: "resume",
		label: "Resume worker",
		description:
			"Start a worker again whose pi is gone (dead: killed, crashed, out of memory) or that was ended. It continues its own conversation, in its tmux session.",
		promptSnippet: "Restart a dead or ended worker in its own conversation",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, { name }) {
			if (name === BOSS) throw new Error("that is you");
			const r = resume(name);
			if (!r.ok) throw new Error(r.error);
			chat({ from: "act", worker: name, text: `resumed ${name}` });
			return ok(`Resuming ${name} in tmux session ${r.session}. It reports in when it is up; tell it what happened.`);
		},
	});

	pi.registerTool({
		name: "stop",
		label: "Stop worker",
		description: "Abort a worker's current run (like pressing Escape). The worker stays open and keeps its conversation.",
		promptSnippet: "Abort a worker's current run",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, { name }) {
			need(name);
			send(name, { from: BOSS, kind: "stop", text: "" });
			chat({ from: "act", worker: name, text: `stopped ${name}` });
			return ok(`Stop sent to ${name}.`);
		},
	});

	pi.registerTool({
		name: "end",
		label: "End worker",
		description: "Shut a worker down when its work is over. Its conversation is kept; with close_tmux its tmux session is closed too.",
		promptSnippet: "Shut a worker down",
		parameters: Type.Object({ name: Type.String(), close_tmux: Type.Optional(Type.Boolean()) }),
		async execute(_id, { name, close_tmux }) {
			const s = need(name);
			send(name, { from: BOSS, kind: "end", text: "" });
			if (close_tmux && s.tmux) setTimeout(() => tmux("kill-session", "-t", `=${s.tmux}`), 4000);
			chat({ from: "act", worker: name, text: `ended ${name}` });
			return ok(`${name} is shutting down.`);
		},
	});
}
