#!/usr/bin/env bun
/**
 * End-to-end check of the worker role with a real (cheap) model, in a throwaway PERCH_HOME
 * and a separate tmux server (-L perch-e2e). Your own tmux server is never touched.
 *   bun test/e2e-worker.ts [provider/model]
 */
import { MODEL2, MODEL as model } from "./common.ts";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/perch-e2e/${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");

const { launch } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p } = store;

const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	console.error(tmux("capture-pane", "-p", "-t", "=t1").out.slice(-3000));
	Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
	process.exit(1);
};

async function until<T>(what: string, fn: () => T | undefined | false, secs = 180): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await Bun.sleep(1000);
	}
	return fail(`timed out waiting for ${what}`) as never;
}

const bossInbox = () => {
	try {
		return readdirSync(p.inbox("boss"))
			.filter((f) => f.endsWith(".json"))
			.sort()
			.map((f) => store.readJson<any>(join(p.inbox("boss"), f)));
	} catch {
		return [];
	}
};

mkdirSync(store.home(), { recursive: true });
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, worker: { model, thinking: "off" } });
store.writeText(
	p.brief("t1"),
	`This is a test of the perch plumbing. Use no other tools than report and ask_boss. Do exactly this:
1. Call report with headline "test started" and milestones ["one", "two", "three"].
2. Call ask_boss with the question "Which color, red or blue?".
3. End your turn and wait.
4. When the answer arrives, call report with headline "picked <the color>", completed 3 and finished true, then end your turn.
`,
);

console.log(`home ${store.home()}, model ${model}`);
const r = launch({ name: "t1", role: "worker", choice: { model, thinking: "off" }, startDir: "~", prompt: `[boss] Read your brief in ${p.brief("t1")} and start.` });
if (!r.ok) fail(r.error ?? "launch");

try {
	const s1 = await until("status asking", () => {
		const s = store.liveStatus("t1");
		return s?.state === "asking" && s;
	});
	console.log(`✓ asking: "${s1.headline}" milestones=${JSON.stringify(s1.milestones)} pending=${s1.pending}`);
	if (s1.headline !== "test started" || s1.milestones.length !== 3) fail("report not applied");

	const q = bossInbox().find((m) => m.kind === "question");
	if (!q || q.from !== "t1" || !q.ref || !/red or blue/i.test(q.text)) fail(`no question in boss inbox: ${JSON.stringify(bossInbox())}`);
	console.log(`✓ boss got question ${q.ref}: ${q.text}`);

	store.send("t1", { from: "boss", kind: "answer", ref: q.ref, text: "Blue." });
	const s2 = await until("status done", () => {
		const s = store.liveStatus("t1");
		return s?.state === "done" && s;
	});
	console.log(`✓ done: "${s2.headline}" completed=${s2.completed}/${s2.milestones.length} pending=${JSON.stringify(s2.pending)} cost=$${s2.cost.toFixed(4)}`);
	if (!/blue/i.test(s2.headline) || s2.completed !== 3 || s2.pending.length) fail("finish not applied");

	const done = await until("done message", () => bossInbox().find((m) => m.kind === "done"), 20);
	console.log(`✓ boss got done: ${done.text.split("\n")[0]}`);

	const events = store.readJsonl<any>(p.events("t1")).map((e) => e.state);
	console.log(`✓ timeline: ${events.join(" → ")}`);
	// Settings page: a per-worker model applies at the worker's next turn (PERCH_TEST_MODEL2, a second model).
	const other = MODEL2;
	store.writeJson(p.settings(), { ...store.loadSettings(), overrides: { t1: { model: other, thinking: "off" } } });
	store.send("t1", { from: "boss", kind: "message", text: "Call report with headline 'model check' and finished true, then end your turn." });
	const s3 = await until("model switch", () => {
		const s = store.liveStatus("t1");
		return s?.model === other && s.headline === "model check" && s.state === "done" && s;
	});
	console.log(other === model ? `✓ per-worker model applied (${s3.model}; set PERCH_TEST_MODEL2 to test a real switch)` : `✓ switched to ${s3.model} via settings`);
	console.log("PASS");
} finally {
	// Explicit socket: never the default server.
	Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
}
