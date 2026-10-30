#!/usr/bin/env bun
/**
 * A worker survives a command that runs out of memory, and a worker whose pi dies is shown as
 * dead (with the reason), reported to the boss, and comes back with Resume.
 * Real (cheap) model, throwaway PERCH_HOME, tmux -L perch-e2e, port 4327.
 *   bun test/e2e-oom.ts [provider/model]
 */
import { MODEL as model } from "./common.ts";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/perch-e2e/oom-${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");
process.env.PERCH_SCOPE_PROPS = "MemorySwapMax=0"; // the 1G limit bites at once instead of swapping
const PORT = 4327;
const base = `http://127.0.0.1:${PORT}`;

const { launch } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p } = store;

const cleanup = () => Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
let server: ReturnType<typeof spawn> | undefined;
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	console.error(`--- hog\n${tmux("capture-pane", "-p", "-t", "hog").out.slice(-2500)}`);
	console.error(`--- status\n${JSON.stringify(store.readStatus("hog"), null, 1)}`);
	server?.kill();
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
const userTexts = (file?: string) =>
	(file ? readFileSync(file, "utf8").split("\n") : [])
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) => (typeof e.message.content === "string" ? e.message.content : e.message.content.map((c: any) => c.text ?? "").join("")));

mkdirSync(store.home(), { recursive: true });
const choice = { model, thinking: "off" };
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, boss: choice, worker: choice, memoryMax: "1G" });
store.writeText(
	p.brief("hog"),
	"Perch memory test. Use only bash and report. 1. Run exactly this command with bash: " +
		`python3 -c 'x = bytearray(3 << 30); x[::4096] = b"a" * len(x[::4096])'; echo "exit=$?" ` +
		"2. report headline 'hog exit <the number after exit=>' with finished true. 3. End your turn.\n",
);
console.log(`home ${store.home()}, model ${model}`);

try {
	const r = launch({ name: "hog", role: "worker", choice, startDir: "/tmp", prompt: `[boss] Read your brief in ${p.brief("hog")} and start.` });
	if (!r.ok) fail(r.error ?? "launch");
	const pid = (await until("hog up", () => store.liveStatus("hog")?.pid)) as number;
	const unit = spawnSync("bash", ["-c", `cat /proc/${pid}/cgroup`], { encoding: "utf8" }).stdout.trim();
	if (!/perch-hog-\d+\.scope/.test(unit)) fail(`pi is not in its own scope: ${unit}`);
	console.log(`✓ pi ${pid} runs in ${unit.split("/").pop()}`);

	// 1. The command runs out of memory; the kernel kills it, pi carries on.
	const done = await until("hog done", () => {
		const s = store.liveStatus("hog");
		return s?.state === "done" && s;
	});
	console.log(`✓ hog: "${done.headline}"`);
	if (!/137/.test(done.headline)) fail("the command was not killed (expected exit 137)");
	if (done.pid !== pid || !store.alive(pid)) fail("pi did not survive");
	console.log(`✓ pi ${pid} survived the OOM kill of its command`);

	// 2. pi dies: dead, with a reason, the boss is told.
	server = spawn("bun", ["bin/perch.ts", "web"], {
		cwd: `${import.meta.dir}/..`,
		env: { ...process.env, PERCH_PORT: String(PORT), PERCH_HOST: "127.0.0.1", PERCH_TLS: "off" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	for (let i = 0; i < 100 && !(await fetch(`${base}/api/state`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
	await Bun.sleep(3000); // keep the kill apart from the OOM above, so the reason is not mixed up
	process.kill(pid, "SIGKILL");
	const dead = await until("marked dead", () => {
		const s = store.readStatus("hog");
		return s?.state === "dead" && s;
	}, 30);
	console.log(`✓ dead: ${dead.error}`);
	const inbox = readdirSync(p.inbox("boss")).map((f) => JSON.parse(readFileSync(join(p.inbox("boss"), f), "utf8")));
	const told = inbox.find((m) => m.kind === "error" && m.from === "hog");
	if (!told) fail("the boss was not told");
	console.log(`✓ boss told: [hog failed] ${told.text.slice(0, 120)}…`);
	const st = await (await fetch(`${base}/api/state`)).json();
	if (st.workers.find((w: any) => w.name === "hog")?.state !== "dead") fail("dashboard does not show it dead");
	console.log("✓ dashboard shows hog dead");

	// 3. Resume: same conversation, told what happened.
	const res = await fetch(`${base}/api/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"hog"}' }).then((r) => r.json());
	if (!res.ok) fail(`resume: ${JSON.stringify(res)}`);
	const back = await until("hog back", () => {
		const s = store.liveStatus("hog");
		return s && s.pid !== pid && store.alive(s.pid) && s.state !== "dead" && s;
	}, 60);
	console.log(`✓ resumed as pid ${back.pid} in tmux ${back.tmux}`);
	await until("restart note delivered", () => userTexts(store.readStatus("hog")?.sessionFile).some((t) => t.startsWith("[perch] Your previous pi died")), 60);
	console.log("✓ the worker was told it died and why, in its own conversation");
} catch (e) {
	fail(String(e));
}
server?.kill();
cleanup();
console.log("PASS");
