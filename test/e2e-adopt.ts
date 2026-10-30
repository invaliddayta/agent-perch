#!/usr/bin/env bun
/**
 * Adopting a running pi: a plain pi with perch loaded (no role) announces itself; writing an
 * adopt request turns it into a worker in place. Throwaway PERCH_HOME, tmux -L perch-e2e.
 *   bun test/e2e-adopt.ts [provider/model]
 */
import { MODEL as model } from "./common.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/perch-e2e/${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");

const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { EXT, GLOBAL_EXT } = await import("../ext/launch.ts");
const extArg = (await Bun.file(GLOBAL_EXT).exists()) ? "" : `-e '${EXT}'`;
const { p } = store;

const cleanup = () => Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}\n${tmux("capture-pane", "-p", "-t", "=plain").out.slice(-2500)}`);
	cleanup();
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

try {
	// A plain pi session, as the user would start one, with perch loaded but no role.
	const cmd = `cd /tmp && PERCH_HOME='${store.home()}' PERCH_EXT='${EXT}' pi --model ${model} --thinking off --session-dir '${root}/sessions' ${extArg} 'You are writing a haiku about tea in /tmp/tea-${Date.now()}.txt. Write it now with the write tool, then stop.'`;
	tmux("new-session", "-d", "-s", "plain", "-x", "200", "-y", "50", cmd);
	const me = await until("presence", () => store.presences().find((x) => x.tmux === "plain"));
	console.log(`✓ present: pid ${me.pid} in tmux ${me.tmux}, cwd ${me.cwd}`);
	await Bun.sleep(5000); // let its own first task run

	store.writeJson(p.adopt(me.pid), { name: "tea" });
	const s = await until("adopted worker reports", () => {
		const s = store.liveStatus("tea");
		return s && s.headline !== "starting" && s.milestones.length > 0 && s;
	});
	console.log(`✓ adopted as tea: ${s.state} · "${s.headline}" · ${s.completed}/${s.milestones.length} ${JSON.stringify(s.milestones)}`);
	if (s.pid !== me.pid) fail("status pid is not the adopted process");
	if (store.presences().some((x) => x.pid === me.pid)) fail("still announced as adoptable");
	await until("brief written", () => existsSync(p.brief("tea")), 120);
	console.log(`✓ brief: ${store.readText(p.brief("tea")).trim().split("\n").slice(0, 3).join(" / ")}`);
	console.log("PASS");
} finally {
	cleanup();
}
