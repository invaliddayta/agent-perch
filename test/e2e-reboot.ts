#!/usr/bin/env bun
/**
 * A reboot, simulated. Before: a boss and a worker run; the tmux server they live in has its own
 * systemd scope. "Shutdown": the tmux server goes (pis get SIGHUP and shut down) and the dashboard
 * stops. "Boot": the dashboard starts (PERCH_BOOT_TIME pretends the machine booted now) and the
 * boss unit runs `perch boss` as a systemd service. Then: the boss is back in its old conversation,
 * in a tmux server that is not inside the unit (stopping the unit leaves it alone), the worker is
 * shown dead because of the restart, the boss is told, and Resume brings the worker back.
 * The boss unit is the one `perch install` writes (its Environment and ExecStart), run in the
 * bare environment a user manager has at boot.
 * Real (cheap) model, throwaway PERCH_HOME, tmux -L perch-e2e, port 4324.
 *   [PERCH_TEST_KEEP_ENV="VAR ..."] bun test/e2e-reboot.ts [provider/model]
 */
import { MODEL as model } from "./common.ts";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = `/tmp/perch-e2e/reboot-${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");
const PORT = 4324;
const base = `http://127.0.0.1:${PORT}`;
const REPO = resolve(import.meta.dir, "..");
const UNIT = `perch-e2e-boss-${Date.now()}`;

/** The perch-boss unit `perch install` writes, as a transient unit: same command and environment, test socket. */
function bossUnitArgs(): string[] {
	const lines = unitFiles({ host: "127.0.0.1", port: PORT }, REPO, process.execPath, process.env.PATH, store.home())["perch-boss"].split("\n");
	const all = (key: string) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
	const env = Object.fromEntries(all("Environment").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
	if (env.PERCH_HOME !== store.home()) fail(`the unit's PERCH_HOME is ${env.PERCH_HOME}`);
	// What a user manager has at boot, before any login (no display, no ssh agent).
	const boot = { HOME: process.env.HOME!, USER: process.env.USER!, LOGNAME: process.env.USER!, SHELL: process.env.SHELL || "/bin/bash", LANG: process.env.LANG || "C.UTF-8",
		XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` };
	// PERCH_TEST_KEEP_ENV: names of variables the test's agents still need (e.g. for your own pi extensions).
	const keep = Object.fromEntries((process.env.PERCH_TEST_KEEP_ENV || "").split(/\s+/).filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
	const vars = { ...boot, ...keep, ...env, PERCH_TMUX_SOCKET: "perch-e2e" };
	return [
		"--user", "--unit", UNIT, "--collect", "-p", "Type=oneshot", "-p", "RemainAfterExit=yes", "-p", "KillMode=process", `--working-directory=${all("WorkingDirectory")[0]}`,
		"/usr/bin/env", "-i", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), ...all("ExecStart")[0].split(" "),
	];
}

const { unitFiles } = await import("../bin/install.ts");
const { launch } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p, BOSS } = store;

let web: ChildProcess | undefined;
const cleanup = () => {
	web?.kill();
	spawnSync("systemctl", ["--user", "stop", UNIT]);
	spawnSync("systemctl", ["--user", "reset-failed", UNIT]);
	spawnSync("tmux", ["-L", "perch-e2e", "kill-server"]);
};
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	for (const s of [BOSS, "w1"]) console.error(`--- ${s}\n${tmux("capture-pane", "-p", "-t", s).out.slice(-1500)}\n${JSON.stringify(store.readStatus(s))}`);
	cleanup();
	process.exit(1);
};
async function until<T>(what: string, fn: () => T | undefined | false, secs = 90): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await Bun.sleep(500);
	}
	return fail(`timed out waiting for ${what}`) as never;
}
const cgroupOf = (pid: number) => readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("/").pop() ?? "";
const tmuxServerPid = () => Number(tmux("display-message", "-p", "#{pid}").out);
const startWeb = async (env: Record<string, string> = {}) => {
	web = spawn("bun", ["bin/perch.ts", "web"], {
		cwd: REPO,
		env: { ...process.env, PERCH_PORT: String(PORT), PERCH_HOST: "127.0.0.1", PERCH_TLS: "off", ...env },
		stdio: ["ignore", "ignore", "inherit"],
	});
	for (let i = 0; i < 100 && !(await fetch(`${base}/api/state`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
};

spawnSync("tmux", ["-L", "perch-e2e", "kill-server"]);
const choice = { model, thinking: "off" };
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, boss: choice, worker: choice });
console.log(`home ${store.home()}, model ${model}`);

try {
	// Before.
	if (!launch({ name: BOSS, role: "boss", choice, startDir: "/tmp" }).ok) fail("boss launch");
	if (!launch({ name: "w1", role: "worker", choice, startDir: "/tmp", prompt: "[boss] Call report with headline 'w1 ready', then run the shell command `sleep 120`, then end your turn." }).ok) fail("w1 launch");
	const boss0 = await until("boss up", () => store.liveStatus(BOSS)?.pid && store.liveStatus(BOSS));
	store.send(BOSS, { from: "user", kind: "user", text: "Just reply OK, nothing else." }); // so it has a conversation to come back to
	await until("boss conversation saved", () => boss0.sessionFile && existsSync(boss0.sessionFile));
	// Busy at the "reboot" (its TUI drawing a running command): pi may die on the first write to the gone
	// terminal before session_shutdown, so the signal has to be noted when it arrives.
	await until("w1 reported and busy", () => store.liveStatus("w1")?.headline === "w1 ready" && tmux("capture-pane", "-p", "-t", "=w1:").out.includes("sleep 120"));
	const scope0 = cgroupOf(tmuxServerPid());
	if (!/^perch-tmux-\d+\.scope$/.test(scope0)) fail(`tmux server is in ${scope0}, not its own scope`);
	console.log(`✓ boss and w1 up; the tmux server has its own scope (${scope0})`);
	await startWeb();

	// Shutdown.
	tmux("kill-server");
	await until("pis gone", () => !store.alive(boss0.pid) && !store.alive(store.readStatus("w1")!.pid), 30);
	web?.kill();
	const w1Down = store.readStatus("w1")!;
	if (w1Down.state === "stopped" || w1Down.signal !== "SIGHUP") fail(`w1 after SIGHUP: state ${w1Down.state}, signal ${w1Down.signal}`);
	console.log(`✓ shutdown: w1 left as "${w1Down.state}" with signal ${w1Down.signal}, not as a clean stop`);

	// Boot.
	await Bun.sleep(1000);
	await startWeb({ PERCH_BOOT_TIME: String(Date.now()) });
	const r = spawnSync("systemd-run", bossUnitArgs(), { encoding: "utf8" });
	if (r.status !== 0) fail(`perch boss as a unit: ${r.stderr}`);
	const boss1 = await until("boss back", () => {
		const s = store.liveStatus(BOSS);
		return s && s.pid !== boss0.pid && store.alive(s.pid) && s;
	});
	if (boss1.sessionFile !== boss0.sessionFile) fail(`boss came back in another conversation: ${boss1.sessionFile} vs ${boss0.sessionFile}`);
	const scope1 = cgroupOf(tmuxServerPid());
	if (!/^perch-tmux-\d+\.scope$/.test(scope1)) fail(`after boot the tmux server is in ${scope1}`);
	console.log(`✓ boot: the boss unit resumed the boss in its old conversation (pid ${boss1.pid}); tmux server in ${scope1}, not in the unit`);
	const bossEnv = readFileSync(`/proc/${boss1.pid}/environ`, "utf8").split("\0");
	if (bossEnv.some((e) => /^(WAYLAND_DISPLAY|DISPLAY|SSH_AUTH_SOCK)=/.test(e))) fail("the boss got a login session's environment; the test should give it a boot one");

	const dead = await until("w1 dead", () => {
		const s = store.readStatus("w1");
		return s?.state === "dead" && s;
	}, 20);
	if (!/restarted/.test(dead.error ?? "")) fail(`reason: ${dead.error}`);
	console.log(`✓ w1 is dead: ${dead.error}`);
	const told = await until("boss told", () =>
		readFileSync(p.inboxLog(BOSS), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.from === "w1" && m.kind === "error"), 20);
	console.log(`✓ boss told: ${told.text.slice(0, 140)}…`);

	// The boss works in that environment: provider login, network, tools.
	const since = Date.now();
	store.send(BOSS, { from: "user", kind: "user", text: "Reply with exactly the word: booted" });
	await until("boss replies after boot", () =>
		store.readJsonl<{ ts: number; from: string; text: string }>(p.chat()).find((l) => l.ts >= since && l.from === "boss" && /booted/i.test(l.text)), 120);
	console.log("✓ the boss answers the user after boot (its model works from the boot environment)");

	// Stopping the unit leaves the boss alone.
	spawnSync("systemctl", ["--user", "stop", UNIT]);
	await Bun.sleep(1500);
	if (!store.alive(boss1.pid)) fail("stopping the boss unit killed the boss");
	console.log("✓ stopping the boss unit leaves the boss running");

	// Resume the worker (unless the boss already did).
	if (store.readStatus("w1")?.state === "dead") {
		const res = await fetch(`${base}/api/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"w1"}' }).then((x) => x.json());
		if (!res.ok && !/is running/.test(res.error ?? "")) fail(`resume: ${JSON.stringify(res)}`);
	}
	const back = await until("w1 back", () => {
		const s = store.liveStatus("w1");
		return s && s.state !== "dead" && store.alive(s.pid) && s;
	}, 60);
	console.log(`✓ w1 resumed (pid ${back.pid})`);
	if (!existsSync(p.run("w1"))) fail("no run.sh");
} catch (e) {
	fail(String(e));
}
cleanup();
console.log("PASS");
