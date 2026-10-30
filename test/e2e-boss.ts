#!/usr/bin/env bun
/**
 * End-to-end check of boss + worker with a real (cheap) model, in a throwaway PERCH_HOME and
 * a separate tmux server (-L perch-e2e). Your own tmux server is never touched.
 *   bun test/e2e-boss.ts [provider/model]
 */
import { MODEL as model } from "./common.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/perch-e2e/${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");

const { launch } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p } = store;

const cleanup = () => Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	for (const s of ["boss", "t2"]) console.error(`--- ${s}\n${tmux("capture-pane", "-p", "-t", `=${s}`).out.slice(-2500)}`);
	console.error(`--- chat\n${JSON.stringify(store.readJsonl(p.chat()), null, 1)}`);
	cleanup();
	process.exit(1);
};
async function until<T>(what: string, fn: () => T | undefined | false, secs = 240): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await Bun.sleep(1000);
	}
	return fail(`timed out waiting for ${what}`) as never;
}
const chat = () => store.readJsonl<store.ChatLine>(p.chat());
const say = (text: string) => {
	store.chat({ from: "user", text });
	store.send("boss", { from: "user", kind: "user", text });
};

mkdirSync(store.home(), { recursive: true });
const choice = { model, thinking: "off" };
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, boss: choice, worker: choice });
console.log(`home ${store.home()}, model ${model}`);

try {
	const r = launch({ name: "boss", role: "boss", choice, startDir: "~" });
	if (!r.ok) fail(r.error ?? "launch boss");
	await until("boss up", () => store.liveStatus("boss")?.pid);
	await until("models.json", () => store.readJson<any>(p.models())?.models?.length);
	console.log(`✓ boss up, ${store.readJson<any>(p.models()).models.length} models listed`);

	say(
		`Start a worker named t2 with this brief, word for word:\n` +
			`"Perch plumbing test. Use only the tools report and ask_boss. 1. report headline 'test started' with milestones ['ask', 'finish']. ` +
			`2. ask_boss 'Which color, red or blue?'. 3. End your turn. 4. When the answer arrives, report headline 'picked <color>' with finished true, then end your turn."\n` +
			`When it asks about the color, answer blue yourself. Then just confirm to me in one line that you started it.`,
	);
	await until("boss reply in chat", () => chat().find((l) => l.from === "boss"));
	console.log(`✓ boss replied: ${chat().find((l) => l.from === "boss")?.text}`);
	await until("act: started t2", () => chat().find((l) => l.from === "act" && /started t2/.test(l.text)));
	console.log("✓ act line: started t2");

	await until("boss answered t2", () => chat().find((l) => l.from === "act" && /answered t2/.test(l.text)));
	console.log(`✓ ${chat().find((l) => l.from === "act" && /answered t2/.test(l.text))?.text}`);
	const s = await until("t2 done", () => {
		const s = store.liveStatus("t2");
		return s?.state === "done" && s;
	});
	console.log(`✓ t2 done: "${s.headline}" ${s.completed}/${s.milestones.length}`);
	if (!/blue/i.test(s.headline)) fail("t2 did not pick blue");

	const before = chat().length;
	store.send("boss", { from: "user", kind: "tap", worker: "t2", text: "" });
	const tap = await until("tap explanation", () => chat().slice(before).find((l) => l.from === "boss"));
	console.log(`✓ tap explanation: ${tap.text}`);

	say("Use ask_user to ask me whether I prefer tea or coffee, with the options tea and coffee. No worker involved.");
	const q = await until("question for the user", () => store.openQuestions()[0]);
	console.log(`✓ question ${q.id}: ${q.question} ${JSON.stringify(q.options)}`);
	store.writeJson(p.question(q.id), { ...q, answered: { ts: Date.now(), text: "coffee" } });
	const n = chat().length;
	store.chat({ from: "user", text: "coffee", ref: q.id });
	store.send("boss", { from: "user", kind: "user_answer", ref: q.id, text: "coffee" });
	await until("boss took the answer", () => store.liveStatus("boss")?.state === "idle" && store.readJsonl<any>(p.inboxLog("boss")).some((m) => m.kind === "user_answer"));
	console.log(`✓ boss took the user's answer; chat since: ${JSON.stringify(chat().slice(n + 1).map((l) => `${l.from}: ${l.text}`))}`);
	console.log(`--- boss terminal (widget above the editor):\n${tmux("capture-pane", "-p", "-t", "=boss").out.split("\n").slice(-14).join("\n")}`);
	console.log("PASS");
} finally {
	cleanup();
}
