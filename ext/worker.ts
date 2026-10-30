/**
 * Worker role: report a headline and milestones, ask the boss, take the boss's messages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runtime } from "./runtime.ts";
import { BOSS, id, loadSettings, p, readStatus, send, userName } from "./store.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export function worker(pi: ExtensionAPI, name: string) {
	let reported = false; // report called during this run
	let finished = false; // report(finished) since the last settle
	let stoppedByBoss = false;
	let driver: "boss" | "user" = "boss"; // who sent the message that started this run
	let noProgress = 0; // boss-driven runs in a row that ended without a report

	const rt = runtime(pi, name, "worker", {
		prompt: () => {
			const u = userName();
			return `## Perch
You are worker "${name}" in ${u}'s perch: several pi agents work in parallel, a boss agent coordinates them, and ${u} talks to the boss. Your brief: ${p.brief(name)}

- The brief says where the work lives. Use absolute paths and cd there in your bash commands. If your session did not start in that project, read its AGENTS.md and HANDOFF.md yourself: they are only loaded automatically from the start directory.
- ${u}'s dashboard shows one line per worker, written only by you with \`report\`. Report right away with a plan of 3-8 milestones, then whenever you finish a milestone or your headline changes meaningfully, at least every 20-30 minutes of work. A good headline is concrete and current, with numbers when there are any ("tile sweep 14/22, best 201.4 tokens/s"), not "working on optimization".
- When the whole task is done, call \`report\` with finished: true and a headline that says what you delivered and where.
- Messages starting with "[boss" come from the boss: follow them like instructions from ${u}. Anything else typed into your session is ${u} directly, and wins over the boss.
- Use \`ask_boss\` for decisions or information you cannot get yourself; decide what you reasonably can on your own. After asking, keep working on whatever does not depend on the answer. If nothing is left, end your turn: the answer arrives as a message.
- Don't stop to ask whether to continue. Keep going until the brief is done or you are blocked.`;
		},

		desiredModel: () => {
			const s = loadSettings();
			return s.overrides[name] ?? (s.applyToRunning ? s.worker : undefined);
		},

		started: (ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus("perch", `perch worker ${name}`);
			// status.json still holds the previous run here. If that pi died, pick the work up again.
			const prev = readStatus(name);
			if (prev?.state === "dead")
				setTimeout(
					() =>
						rt.deliver(
							`[perch] Your previous pi died and you were restarted. Why: ${prev.error ?? "unknown"}. ` +
								"Check where you were and carry on. Don't walk into the same wall: run memory-hungry commands under a limit, " +
								"e.g. systemd-run --user --scope -q -p MemoryMax=8G -- <cmd>.",
						),
					1500,
				);
		},

		message: (m) => {
			if (m.role !== "user") return;
			const text = typeof m.content === "string" ? m.content : (m.content?.find((c: any) => c.type === "text")?.text ?? "");
			driver = text.startsWith("[boss") || text.startsWith("[perch]") ? "boss" : "user";
			if (driver === "user") noProgress = 0;
		},

		handle: (msg) => {
			const s = rt.status();
			switch (msg.kind) {
				case "message":
					rt.deliver(`[boss] ${msg.text}`, msg.urgent, msg.images);
					break;
				case "answer":
					if (s) rt.update({ pending: s.pending.filter((q) => q !== msg.ref) });
					rt.deliver(`[boss answers ${msg.ref}] ${msg.text}`, msg.urgent, msg.images);
					break;
				case "stop":
					stoppedByBoss = true;
					rt.ctx()?.abort();
					break;
				case "end":
					rt.setState("stopped");
					rt.ctx()?.shutdown();
					break;
			}
		},

		settled: ({ aborted, text, error }) => {
			const s = rt.status();
			if (!s) return;
			const wasFinished = finished;
			finished = false;
			if (stoppedByBoss || aborted) {
				stoppedByBoss = false;
				rt.setState("idle");
				return;
			}
			if (error) {
				rt.setState("error", { error });
				send(BOSS, { from: name, kind: "error", text: error });
				return;
			}
			if (wasFinished) {
				rt.setState("done");
				send(BOSS, { from: name, kind: "done", text: `${s.headline}\n\nLast message:\n${text.slice(-1500)}` });
				return;
			}
			if (s.pending.length) {
				rt.setState("asking");
				return;
			}
			rt.setState("idle");
			if (driver === "user") return; // the user is driving this worker directly
			noProgress = reported ? 0 : noProgress + 1;
			send(BOSS, {
				from: name,
				kind: "settled",
				text: text.slice(-1500) || "(no text)",
				meta: { noProgress },
			});
		},
	});

	pi.on("agent_start", () => {
		reported = false;
	});

	pi.registerTool({
		name: "report",
		label: "Report",
		description:
			"Update your line on the dashboard: a one-line headline, optionally your milestone plan and how many milestones are done, or that the whole task is finished.",
		promptSnippet: "Update your dashboard headline and milestone progress",
		parameters: Type.Object({
			headline: Type.String({
				description: "One concrete, current line, numbers where there are any, at most about 100 characters.",
			}),
			milestones: Type.Optional(
				Type.Array(Type.String(), { description: "Your plan as 3-8 short milestone names. Replaces the previous plan." }),
			),
			completed: Type.Optional(Type.Number({ description: "How many milestones, counted from the start of the list, are done." })),
			finished: Type.Optional(Type.Boolean({ description: "true when the whole task is done." })),
		}),
		async execute(_id, params) {
			const s = rt.status();
			if (!s) throw new Error("perch is not running in this session");
			const milestones = params.milestones?.map((m) => m.trim()).filter(Boolean) ?? s.milestones;
			let completed = params.completed ?? (params.milestones ? 0 : s.completed);
			if (params.finished) completed = milestones.length;
			completed = Math.max(0, Math.min(milestones.length, Math.round(completed)));
			rt.update({ headline: params.headline.trim().slice(0, 200), milestones, completed });
			reported = true;
			noProgress = 0;
			if (params.finished) finished = true;
			return ok(params.finished ? "Reported as finished. End your turn." : "Reported.");
		},
	});

	pi.registerTool({
		name: "ask_boss",
		label: "Ask boss",
		description:
			"Ask the boss for a decision or information you cannot get yourself. Returns at once; the answer arrives later as a message starting with [boss answers <id>].",
		promptSnippet: "Ask the boss for a decision or information",
		parameters: Type.Object({
			question: Type.String({ description: "The question, answerable without reading your whole session." }),
			context: Type.Optional(Type.String({ description: "What you know, what you tried, the options you see and which you would pick." })),
		}),
		async execute(_id, params) {
			const s = rt.status();
			if (!s) throw new Error("perch is not running in this session");
			const ref = id("q");
			send(BOSS, {
				from: name,
				kind: "question",
				ref,
				text: params.context ? `${params.question}\n\nContext: ${params.context}` : params.question,
			});
			rt.update({ pending: [...s.pending, ref] });
			return ok(
				`Sent to the boss as ${ref}. Keep working on anything that does not depend on the answer; if nothing is left, end your turn. The answer arrives as a message starting with [boss answers ${ref}].`,
			);
		},
	});
	return rt;
}
