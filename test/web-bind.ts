#!/usr/bin/env bun
/**
 * Boot without the Tailscale address: the dashboard must not crash when PERCH_HOST cannot be
 * bound yet. It serves 127.0.0.1 (what `tailscale serve` uses) meanwhile and takes the address as
 * soon as it can. Stand-in for the missing address: 127.0.0.2, held by another listener first.
 * Both the TLS front and plain HTTP (PERCH_TLS=off). No agents; throwaway home; ports 4333-4334.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";

let failed = false;
const ok = (cond: unknown, what: string) => {
	console.log(`${cond ? "✓" : "✗"} ${what}`);
	if (!cond) failed = true;
};
const up = (url: string) => fetch(`${url}/api/state`).then((r) => r.ok, () => false);
async function until(fn: () => Promise<boolean>, secs: number) {
	for (let end = Date.now() + secs * 1000; Date.now() < end; await Bun.sleep(200)) if (await fn()) return true;
	return false;
}

for (const [port, tls] of [[4333, "front"], [4334, "off"]] as const) {
	const root = `/tmp/perch-e2e/bind-${tls}-${Date.now()}`;
	mkdirSync(root, { recursive: true });
	const blocker = createServer((c) => c.destroy());
	await new Promise<void>((r) => blocker.listen(port, "127.0.0.2", r));
	let web: ChildProcess | undefined;
	try {
		let log = "";
		web = spawn("bun", ["bin/perch.ts", "web"], {
			cwd: `${import.meta.dir}/..`,
			env: {
				...process.env,
				PERCH_HOME: root,
				PERCH_TMUX_SOCKET: "perch-e2e",
				PERCH_HOST: "127.0.0.2",
				PERCH_PORT: String(port),
				...(tls === "off" ? { PERCH_TLS: "off" } : { PERCH_TLS_DOMAIN: "perch-bind-test.invalid" }),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		web.stdout!.on("data", (d) => (log += d));
		web.stderr!.on("data", (d) => (log += d));
		let exited = false;
		web.on("exit", () => (exited = true));

		ok(await until(() => up(`http://127.0.0.1:${port}`), 15), `${tls}: 127.0.0.1:${port} serves while 127.0.0.2:${port} is taken`);
		await Bun.sleep(1500);
		ok(!exited, `${tls}: still running`);
		ok(/cannot listen on http:\/\/127\.0\.0\.2/.test(log), `${tls}: says it is waiting for the address`);
		await new Promise((r) => blocker.close(r));
		ok(await until(() => up(`http://127.0.0.2:${port}`), 12), `${tls}: takes 127.0.0.2:${port} once it is free`);
		ok(/listening on http:\/\/127\.0\.0\.2:\d+ now/.test(log), `${tls}: says so`);
		if (failed) console.log(log);
	} finally {
		web?.kill();
		blocker.close();
	}
}

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
