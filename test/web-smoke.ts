#!/usr/bin/env bun
/**
 * Dashboard smoke test, no agents: page and assets, same-origin guard, a browser terminal over a
 * websocket (input, output, sizing, history), and the adopt safety check on a fake pi screen.
 * Throwaway PERCH_HOME, tmux -L perch-e2e, port 4329.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const root = `/tmp/perch-e2e/web-${Date.now()}`;
mkdirSync(root, { recursive: true });
process.env.PERCH_HOME = root;
process.env.PERCH_TMUX_SOCKET = "perch-e2e";
const PORT = 4329;
const base = `http://127.0.0.1:${PORT}`;
const { tmux } = await import("../ext/tmux.ts");
const { editorState } = await import("../web/adopt.ts");

let failed = false;
const ok = (cond: unknown, what: string) => {
	console.log(`${cond ? "✓" : "✗"} ${what}`);
	if (!cond) failed = true;
};

tmux("kill-session", "-t", "=smoke");
tmux("new-session", "-d", "-s", "smoke", "-x", "120", "-y", "40", "bash --norc");
const server = spawn("bun", ["bin/perch.ts", "web"], {
	cwd: `${import.meta.dir}/..`,
	env: { ...process.env, PERCH_PORT: String(PORT), PERCH_HOST: "127.0.0.1" },
	stdio: ["ignore", "pipe", "inherit"],
});
try {
	for (let i = 0; i < 100; i++) {
		if (await fetch(`${base}/api/state`).then((r) => r.ok, () => false)) break;
		await Bun.sleep(100);
	}
	const page = await fetch(`${base}/`);
	const html = await page.text();
	ok(page.ok && html.includes("/assets/main.js?b="), "page served with a cache-busted bundle");
	ok(page.headers.get("cross-origin-embedder-policy") === "require-corp", "cross-origin isolated (speech threads)");
	const js = html.match(/\/assets\/main\.js\?b=\w+/)![0];
	ok((await fetch(base + js)).ok, "bundle served");
	ok((await fetch(`${base}/fonts/term-mono-Regular.woff2`)).ok, "terminal font served");
	const st = await (await fetch(`${base}/api/state`)).json();
	ok(st.machine?.mem.total > 0 && st.machine.cpu >= 0 && st.machine.cores > 0, "machine stats (CPU, RAM, swap)");
	ok(st.unmanaged.some((t: { name: string }) => t.name === "smoke"), "tmux session listed as unmanaged");
	if (st.secureUrl) {
		// Same port, TLS: the certificate is for the tailnet name, so only check that HTTPS answers here.
		const r = await fetch(`https://127.0.0.1:${PORT}/api/state`, { tls: { rejectUnauthorized: false } } as any);
		ok(r.ok && (await r.json()).secureUrl === st.secureUrl, `HTTPS on the same port (${st.secureUrl})`);
	} else console.log("- no HTTPS (tailscale cert not available here)");

	const evil = await fetch(`${base}/api/chat`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: '{"text":"rm -rf"}' });
	ok(evil.status === 403, "cross-origin POST refused");
	const curl = await fetch(`${base}/api/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"session":"smoke","name":"smoke"}' });
	const cj = await curl.json();
	ok(curl.status === 400 && /no pi/.test(cj.error), `adopt of a shell refused with a reason: ${cj.error}`);

	// Terminal: attach, type, see the output; the real session keeps its size (nobody else attached → fit).
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/term?session=smoke&cols=70&rows=20`, { headers: { origin: base } } as any);
	ws.binaryType = "arraybuffer";
	let out = "";
	const grids: any[] = [];
	ws.onmessage = (e) => {
		if (typeof e.data === "string") {
			const m = JSON.parse(e.data);
			if (m.t === "grid") grids.push(m);
		} else out += new TextDecoder().decode(e.data);
	};
	await new Promise((r, j) => {
		ws.onopen = r;
		ws.onerror = j;
	});
	await Bun.sleep(800);
	ws.send(JSON.stringify({ t: "in", d: "echo perch-$((6*7))\r" }));
	for (let i = 0; i < 40 && !out.includes("perch-42"); i++) await Bun.sleep(100);
	ok(out.includes("perch-42"), "typed into the terminal and saw the output");
	ok(grids[0]?.cols === 70 && grids[0]?.shared === false, `alone: fits the browser (${grids[0]?.cols}×${grids[0]?.rows})`);
	const size = tmux("display-message", "-p", "-t", "=smoke:", "#{window_width}x#{window_height}").out;
	ok(size === "70x20", `window follows the browser when nobody else is attached (${size})`);
	ok(tmux("show-options", "-v", "-t", "=smoke:", "status").out !== "off", "the real session's options are untouched");
	ws.send(JSON.stringify({ t: "mode", mode: "passive" }));
	await Bun.sleep(400);
	const flags = tmux("list-clients", "-F", "#{client_session} #{client_flags}").out;
	ok(/__perch_view_\w+ .*ignore-size/.test(flags), "a hidden page stops sizing the window");

	const hist = await (await fetch(`${base}/api/history?session=smoke`)).json();
	ok(hist.text?.includes("perch-42"), "history has the scrollback");
	ws.close();
	await Bun.sleep(600);
	ok(!tmux("list-sessions", "-F", "#{session_name}").out.includes("__perch_view_"), "viewer session cleaned up");

	// The session is closed while a browser shows it: the viewer must not keep its windows alive.
	tmux("new-session", "-d", "-s", "smoke2", "-x", "80", "-y", "24", "bash --norc");
	const ws2 = new WebSocket(`${base.replace("http", "ws")}/api/term?session=smoke2&cols=80&rows=24`, { headers: { origin: base } } as any);
	await new Promise((r) => (ws2.onopen = r));
	await Bun.sleep(800);
	const closed = new Promise<number>((r) => (ws2.onclose = (e) => r(e.code)));
	tmux("kill-session", "-t", "=smoke2");
	const code = await Promise.race([closed, Bun.sleep(5000).then(() => 0)]);
	await Bun.sleep(300);
	ok(code === 1000 && !tmux("list-sessions", "-F", "#{session_name}").out.includes("__perch_view_"), "terminal of a closed session ends, and its viewer goes");

	// pi editor detection on captured screens.
	const rule = "─".repeat(40);
	ok(editorState(`hi\n${rule}\n\n${rule}\n${rule}\n\n${rule}\n~/x\n$0.01`) === "idle", "idle pi with an empty editor");
	ok(editorState(`hi\n── ⠇ Working ${rule}\n\n${rule}\n~/x`) === "busy", "working pi");
	ok(editorState(`hi\n${rule}\nhalf a thought\n${rule}\n~/x`) === "typed", "pi with unsent text");
	ok(editorState("$ ls\nfoo bar") === "unknown", "not a pi screen");
} finally {
	server.kill();
	tmux("kill-session", "-t", "=smoke");
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
