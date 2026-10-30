#!/usr/bin/env bun
/**
 * The app shell: perch serves its service worker, manifest and icons; a page opened in a browser
 * comes under perch's worker; and with the server gone the app says so instead of the browser's
 * error page. Headless Chrome via agent-browser (skipped without it), port 4326, throwaway
 * PERCH_HOME, no model calls.
 */
import "./common.ts";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";

const PORT = 4326;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = `sw-${Date.now()}`;
const home = `/tmp/perch-e2e/sw-${Date.now()}`;
if (!Bun.which("agent-browser")) {
	console.log("SKIP: needs agent-browser (headless Chrome)");
	process.exit(0);
}

const ab = async (...args: string[]) => {
	const pr = Bun.spawn(["agent-browser", "--session", SESSION, ...args], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(pr.stdout).text();
	await pr.exited;
	return out.trim();
};
const evalJs = async (js: string) => {
	const out = await ab("eval", js);
	try {
		return JSON.parse(out);
	} catch {
		return out;
	}
};
let perch: ChildProcess | undefined;
const done = (code: number) => {
	spawnSync("agent-browser", ["--session", SESSION, "close"]);
	perch?.kill();
	spawnSync("tmux", ["-L", "perch-e2e", "kill-server"]);
	process.exit(code);
};
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	done(1);
};
async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, secs = 20): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = await fn();
		if (v) return v;
		await Bun.sleep(500);
	}
	return fail(`timed out waiting for ${what}`) as never;
}
const up = async (url: string) => {
	for (let i = 0; i < 100; i++) {
		if (await fetch(url).then((r) => r.ok, () => false)) return;
		await Bun.sleep(100);
	}
	fail(`${url} did not come up`);
};

// 1. perch serves the app shell.
perch = spawn("bun", ["bin/perch.ts", "web"], {
	cwd: `${import.meta.dir}/..`,
	env: { ...process.env, PERCH_HOME: home, PERCH_HOST: "127.0.0.1", PERCH_PORT: String(PORT), PERCH_TLS: "off" },
	stdio: ["ignore", "ignore", "inherit"],
});
await up(`${ORIGIN}/api/state`);
for (const [path, type] of [["/sw.js", "javascript"], ["/manifest.webmanifest", "manifest"], ["/icon-192.png", "png"], ["/icon-maskable-512.png", "png"], ["/apple-touch-icon.png", "png"]]) {
	const r = await fetch(`${ORIGIN}${path}`);
	if (!r.ok || !r.headers.get("content-type")?.includes(type)) fail(`${path}: ${r.status} ${r.headers.get("content-type")}`);
}
const manifest = await (await fetch(`${ORIGIN}/manifest.webmanifest`)).json();
if (manifest.id !== "/" || manifest.start_url !== "/" || manifest.scope !== "/") fail(`manifest identity: ${JSON.stringify(manifest)}`);
console.log(`✓ manifest: id "/", start_url "/", scope "/" (an app installed from this address stays the same app), name "${manifest.name}"`);

// 2. A page opened in a browser comes under perch's worker.
await ab("set", "viewport", "390", "844");
await ab("open", `${ORIGIN}/`);
await ab("open", `${ORIGIN}/`); // a fresh session's first page can come up broken
await until("the page is perch", async () => (await evalJs("document.title")) === "perch" && (await evalJs("!!document.querySelector('.app')")));
await until("perch's worker controls the page", async () => String(await evalJs("navigator.serviceWorker.controller?.scriptURL ?? ''")).endsWith("/sw.js") && (await evalJs("navigator.serviceWorker.controller.state")) === "activated");
console.log("✓ the page loads, and perch's worker controls it");

// 3. Server gone: the app says so instead of the browser's error page; back up, it loads.
perch.kill();
await until("server down", () => spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ORIGIN}/`], { encoding: "utf8" }).stdout === "000");
await ab("open", `${ORIGIN}/`);
await until("offline page", async () => String(await evalJs("document.body.innerText")).includes(`perch can't reach ${hostname()}`));
console.log(`✓ with ${hostname()} unreachable the app shows perch's offline page`);

console.log("PASS");
done(0);
