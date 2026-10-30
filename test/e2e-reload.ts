#!/usr/bin/env bun
/**
 * /reload keeps an agent's role. A worker reloads and is still the worker; a pi whose role was
 * lost by an older perch's reload (dormant, but its status file has its pid) gets it back.
 * No model calls. Throwaway PERCH_HOME, tmux -L perch-e2e.
 */
import { MODEL } from "./common.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/perch-e2e/reload-${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");

const { launch, EXT, GLOBAL_EXT } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p } = store;

const cleanup = () => Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	for (const s of ["rw", "plain"]) console.error(`--- ${s}\n${tmux("capture-pane", "-p", "-t", s).out.slice(-1500)}`);
	cleanup();
	process.exit(1);
};
async function until<T>(what: string, fn: () => T | undefined | false, secs = 60): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await Bun.sleep(500);
	}
	return fail(`timed out waiting for ${what}`) as never;
}
const reload = (session: string) => {
	tmux("send-keys", "-t", `=${session}:`, "-l", "/reload");
	tmux("send-keys", "-t", `=${session}:`, "Enter");
};

mkdirSync(store.home(), { recursive: true });
const choice = { model: MODEL, thinking: "off" };
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, boss: choice, worker: choice });

try {
	// 1. A worker started by perch reloads and is still the worker.
	launch({ name: "rw", role: "worker", choice, startDir: "/tmp" });
	const s0 = await until("rw up", () => store.liveStatus("rw")?.pid && store.liveStatus("rw"));
	await Bun.sleep(2000);
	reload("rw");
	const s1 = await until("rw back after reload", () => {
		const s = store.readStatus("rw");
		return s && s.started > s0.started && s.state !== "stopped" && s;
	});
	if (s1.pid !== s0.pid) fail("different process");
	if (store.presences().some((x) => x.pid === s0.pid)) fail("it went dormant");
	console.log(`✓ worker rw is still rw after /reload (pid ${s1.pid}, state ${s1.state})`);

	// 2. A dormant pi whose status file has its pid (role lost by an older reload) gets it back.
	const extArg = (await Bun.file(GLOBAL_EXT).exists()) ? "" : `-e '${EXT}'`;
	tmux(
		"new-session", "-d", "-s", "plain", "-x", "160", "-y", "40",
		`cd /tmp && PERCH_HOME='${store.home()}' PERCH_EXT='${EXT}' pi --model ${choice.model} --thinking off --session-dir '${root}/s' ${extArg}`,
	);
	const pres = await until("plain announces itself", () => store.presences().find((x) => x.tmux === "plain"));
	const t = Date.now();
	store.writeJson(p.status("lost"), {
		name: "lost", role: "worker", state: "stopped", headline: "was a worker", milestones: [], completed: 0,
		started: t, updated: t, heartbeat: t, pid: pres.pid, cost: 0, tokens: 0, activity: [], activityAt: t, pending: [],
	});
	reload("plain");
	const s2 = await until("plain is worker 'lost' again", () => {
		const s = store.readStatus("lost");
		return s && s.started > t && s.state !== "stopped" && s;
	});
	if (s2.pid !== pres.pid) fail("different process");
	console.log(`✓ a pi whose role was lost got it back on /reload (lost, pid ${s2.pid}, headline "${s2.headline}")`);
} catch (e) {
	fail(String(e));
}
cleanup();
console.log("PASS");
