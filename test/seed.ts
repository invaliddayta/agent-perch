#!/usr/bin/env bun
/**
 * Fill a throwaway PERCH_HOME with fake workers, questions and chat, to look at the dashboard
 * without running agents. Fake "processes" are a sleep, so they read as alive.
 *   PERCH_HOME=/tmp/perch-seed bun test/seed.ts
 */
import { spawn } from "node:child_process";
import { appendJsonl, DEFAULT_SETTINGS, p, type Status, writeJson, writeText } from "../ext/store.ts";

if (!process.env.PERCH_HOME?.startsWith("/tmp/")) throw new Error("set PERCH_HOME to a /tmp directory");
const sleeper = spawn("sleep", ["86400"], { detached: true, stdio: "ignore" });
sleeper.unref();
const pid = sleeper.pid!;
const now = Date.now();
const H = 3600_000;

const base = (name: string, over: Partial<Status>): Status => ({
	name,
	role: "worker",
	state: "working",
	headline: "",
	milestones: [],
	completed: 0,
	started: now, // the sleep "process" started just now (a process younger than its status would be another one)
	updated: now - 60_000,
	heartbeat: now,
	pid,
	tmux: name,
	model: "anthropic/claude-sonnet-4-5",
	thinking: "high",
	cost: 3.2,
	tokens: 1_200_000,
	context: 41,
	activity: [2, 3, 5, 8, 6, 7, 9, 8, 6, 4, 2, 1],
	activityAt: now,
	pending: [],
	...over,
});

const workers: [Status, [number, string][]][] = [
	[
		base("paper-figs", { headline: "Redrew 9/14 figures. Figure 6 needs Sam's call on the color scheme.", milestones: ["inventory", "style", "plots", "diagrams", "captions", "final check"], completed: 3, cost: 12.8 }),
		[[-12, "working"], [-9, "idle"], [-4, "working"], [-0.4, "working"]],
	],
	[
		base("api-bench", { headline: "Batch tuning: 4,210 req/s at p99 38 ms (was 3,050, goal ≥4,500)", milestones: ["baseline", "pooling", "batching", "batch sweep", "verify", "writeup"], completed: 3, cost: 9.1, activity: [6, 7, 9, 9, 8, 9, 10, 9, 10, 9, 10, 10] }),
		[[-12, "working"], [-10.8, "asking"], [-10.5, "working"]],
	],
	[
		base("scraper", { state: "asking", headline: "Scraper core done, 12/20 tests passing. Asking boss about storage format.", milestones: ["schema", "fetch", "parse", "store", "tests"], completed: 3, cost: 4.3, pending: ["qx1"] }),
		[[-11, "working"], [-7.5, "asking"], [-7.3, "working"], [-0.2, "asking"]],
	],
	[
		base("pose-eval", { state: "done", headline: "Pose model eval report written: mAP 0.71 (+0.06 vs baseline)", milestones: ["data", "train", "eval", "report"], completed: 4, cost: 8.7, updated: now - 5 * H, activity: [8, 9, 9, 7, 5, 3, 0, 0, 0, 0, 0, 0] }),
		[[-12, "working"], [-4.8, "done"]],
	],
	[
		base("game-jam", { state: "idle", headline: "Level 3 boss fight playable. Waiting for next task.", milestones: ["movement", "levels", "boss fight", "polish"], completed: 3, cost: 2.7, updated: now - 9 * H, activity: Array(12).fill(0) }),
		[[-12, "working"], [-9.4, "idle"]],
	],
	[
		base("db-migrate", { state: "error", headline: "Migrating the DB schema", error: "529 overloaded_error: Overloaded", cost: 0.4 }),
		[[-1, "working"], [-0.1, "error"]],
	],
];

for (const [s, events] of workers) {
	writeJson(p.status(s.name), s);
	writeText(p.brief(s.name), `# ${s.name}\nfake brief\n`);
	for (const [h, state] of events) appendJsonl(p.events(s.name), { ts: now + h * H, state, headline: s.headline });
}
writeJson(p.status("boss"), base("boss", { role: "boss", state: "idle", headline: "ready", cost: 6.1 }));
writeJson(p.settings(), { ...DEFAULT_SETTINGS, userName: "Sam" });

writeJson(p.question("pq1"), {
	id: "pq1",
	ts: now - 120_000,
	worker: "paper-figs",
	question: "Figure 6: keep the journal's grayscale, or use the colorblind-safe palette from figures 1-5?",
	options: ["Grayscale", "Palette", "Make both"],
	context: "Both print fine. I'd use the palette; it matches the other figures.",
});

const lines: [number, string, string, string?][] = [
	[-2 * H, "boss", "Morning. Overnight: api-bench went 3,050 → 4,210 req/s, pose-eval finished its report (mAP 0.71) and paper-figs redrew 9/14 figures."],
	[-1.9 * H, "act", "answered api-bench: keep the warm-up protocol identical to the baseline", "api-bench"],
	[-1.8 * H, "act", "answered scraper: store raw HTML + parsed rows", "scraper"],
	[-1.5 * H, "user", "is api-bench going to make 4500 today?"],
	[-1.49 * H, "boss", "Probably not from batching alone. The sweep's best is `batch 64` at **4,210**; I'd plan connection reuse after the sweep. Queue it?"],
	[-1.4 * H, "user", "yes queue it. and give me the state of everything"],
	[
		-1.39 * H,
		"boss",
		"Queued connection reuse for api-bench. Here's where everything stands:\n\n### Running\n- **api-bench**: batch sweep, 3/6 milestones\n  - best so far `batch 64` → 4,210 req/s\n  - next: verify, then connection reuse\n- **paper-figs**: 9/14 figures redrawn\n  - waiting on you for figure 6\n- **scraper**: 12/20 tests pass\n\n### Done\n1. pose-eval: report written, mAP **0.71** (+0.06)\n2. game-jam: level 3 boss fight playable\n\nTo rerun the sweep by hand:\n\n```sh\ncd ~/src/api && ./bench.sh --batch 64 --runs 5\n```\n\nDetails are in [the bench notes](https://example.com/bench).",
	],
	[-0.04 * H, "boss", "paper-figs: Figure 6: keep the journal's grayscale, or use the colorblind-safe palette from figures 1-5?", "paper-figs"],
];
for (const [h, from, text, worker] of lines) appendJsonl(p.chat(), { ts: now + h, from, text, worker, ref: from === "boss" && worker ? "pq1" : undefined });

// Terminals for the fake agents on the test tmux server (never your own).
if (process.env.PERCH_TMUX_SOCKET) {
	const { tmux } = await import("../ext/tmux.ts");
	for (const name of ["boss", ...workers.map(([s]) => s.name)]) {
		tmux("kill-session", "-t", `=${name}`);
		tmux("new-session", "-d", "-s", name, "-x", "160", "-y", "45", `bash --norc -c 'printf "\\e[1;32m${name}\\e[0m fake terminal\\n"; for i in $(seq 1 120); do printf "line %3d  \\e[2m─────────────────────\\e[0m  ⠇ working  ✓ done  → next\\n" $i; done; exec bash --norc'`);
	}
}
console.log(`seeded ${process.env.PERCH_HOME} (sleep pid ${pid})`);
