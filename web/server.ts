/**
 * perch dashboard: serves the page (web/src, bundled at startup), a small JSON API over the files
 * in PERCH_HOME, and browser terminals (web/term.ts). It never talks to pi directly; it writes
 * inbox messages and the agents do the rest.
 *
 *   PERCH_PORT (4320)   PERCH_HOST (127.0.0.1; use the Tailscale IP for the phone)
 *   HTTPS (the microphone needs it): see web/tls.ts
 *   PERCH_LOCAL_PORT    with PERCH_HOST set to another address, also plain http on
 *                          127.0.0.1 at this port (default PERCH_PORT; "off" for none), for
 *                          `tailscale serve`, which puts perch at https://<machine>.<tailnet>.ts.net/
 *   PERCH_PUBLIC_URL    the address to send people to for HTTPS (that serve address)
 */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { launch, resume } from "../ext/launch.ts";
import {
	appendJsonl,
	BOSS,
	type ChatLine,
	chat,
	accountName,
	defaultGuidance,
	home,
	IMAGE_TYPES,
	imageNote,
	listAgents,
	liveStatus,
	loadGuidance,
	loadSettings,
	MEDIA_RE,
	mtime,
	NAME_RE,
	openQuestions,
	p,
	type Presence,
	presences,
	type Question,
	readJson,
	saveImage,
	readJsonl,
	readStatus,
	running,
	type Settings,
	type Status,
	send,
	userName,
	writeJson,
	writeText,
} from "../ext/store.ts";
import { hasSession, sessions } from "../ext/tmux.ts";
import { piUnder, type Procs, procs, reloadPi } from "./adopt.ts";
import { build, DIST } from "./build.ts";
import { closeTerm, history, openTerm, reapViewers, type TermData, termData, termMessage } from "./term.ts";
import { type Listening, listen, type Serve } from "./tls.ts";

const PORT = Number(process.env.PERCH_PORT || 4320);
const HOST = process.env.PERCH_HOST || "127.0.0.1";
const LOCAL_PORT = process.env.PERCH_LOCAL_PORT === "off" || HOST === "127.0.0.1" ? 0 : Number(process.env.PERCH_LOCAL_PORT || PORT);
const PUBLIC_URL = process.env.PERCH_PUBLIC_URL?.replace(/\/?$/, "/");
const VOICE = join(import.meta.dir, "voice");
const VERSION = spawnSync("git", ["-C", import.meta.dir, "log", "-1", "--format=%h %cs"], { encoding: "utf8" }).stdout?.trim() || undefined;
const WINDOW = 12 * 3600_000;

await build();
reapViewers();

// ---------------------------------------------------------------- data

let gpu: { util: number; used: number; total: number; name: string } | undefined;
function pollGpu() {
	const r = spawnSync("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total,name", "--format=csv,noheader,nounits"], {
		encoding: "utf8",
	});
	if (r.status !== 0) return;
	const [util, used, total, name] = r.stdout.trim().split("\n")[0].split(", ");
	gpu = { util: Number(util), used: Number(used), total: Number(total), name };
}

/** CPU (all cores, % busy since the last poll), memory and swap (GiB), from /proc. */
let machine: { cpu: number; cores: number; mem: { used: number; total: number }; swap: { used: number; total: number } } | undefined;
let lastCpu: number[] | undefined;
function pollMachine() {
	try {
		const cpu = readFileSync("/proc/stat", "utf8").split("\n", 1)[0].trim().split(/\s+/).slice(1, 9).map(Number); // user … steal
		const idle = (c: number[]) => c[3] + (c[4] || 0); // idle + iowait
		const sum = (c: number[]) => c.reduce((a, b) => a + b, 0);
		let busy = 0;
		if (lastCpu) {
			const total = sum(cpu) - sum(lastCpu);
			busy = total > 0 ? Math.round((1 - (idle(cpu) - idle(lastCpu)) / total) * 100) : 0;
		}
		lastCpu = cpu;
		const info = readFileSync("/proc/meminfo", "utf8");
		const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
		const G = 1024 * 1024;
		machine = {
			cpu: Math.max(0, Math.min(100, busy)),
			cores: navigator.hardwareConcurrency,
			mem: { used: (kb("MemTotal") - kb("MemAvailable")) / G, total: kb("MemTotal") / G },
			swap: { used: (kb("SwapTotal") - kb("SwapFree")) / G, total: kb("SwapTotal") / G },
		};
	} catch {}
}
const pollAll = () => {
	pollGpu();
	pollMachine();
};
pollAll();
setInterval(pollAll, 5000);

type Segment = [number, number, string]; // start, end, state

function timeline(name: string, now: number): Segment[] {
	const events = readJsonl<{ ts: number; state: string }>(p.events(name), 2000);
	const from = now - WINDOW;
	const segs: Segment[] = [];
	for (let i = 0; i < events.length; i++) {
		const start = Math.max(events[i].ts, from);
		const end = Math.min(events[i + 1]?.ts ?? now, now);
		if (end <= from || end <= start) continue;
		const last = segs[segs.length - 1];
		if (last && last[2] === events[i].state && last[1] === start) last[1] = end;
		else segs.push([start, end, events[i].state]);
	}
	// A dead agent's last state ends when its heartbeat stopped.
	const s = liveStatus(name);
	if ((s?.state === "stopped" || s?.state === "dead") && segs.length) {
		const last = segs[segs.length - 1];
		if (last[2] !== s.state && s.heartbeat < last[1]) {
			last[1] = Math.max(last[0], s.heartbeat);
			segs.push([last[1], now, s.state]);
		}
	}
	return segs;
}

let modelCache: { at: number; models: unknown[] } | undefined;
function models() {
	const fromBoss = readJson<{ updated: number; models: unknown[] }>(p.models());
	if (fromBoss?.models?.length) return fromBoss.models;
	// The boss has not run yet: ask pi directly.
	if (!modelCache || Date.now() - modelCache.at > 600_000) {
		const r = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 60_000 });
		const rows = (r.stdout || "").split("\n").slice(1).filter(Boolean);
		modelCache = {
			at: Date.now(),
			models: rows.map((row) => {
				const [provider, id, , , thinking] = row.trim().split(/\s+/);
				return {
					id: `${provider}/${id}`,
					provider,
					name: id,
					reasoning: thinking === "yes",
					thinking: thinking === "yes" ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : ["off"],
				};
			}),
		};
	}
	return modelCache.models;
}

function state() {
	const now = Date.now();
	const agents = listAgents()
		.map(liveStatus)
		.filter((s): s is Status => !!s);
	const tmuxNow = sessions();
	const names = new Set(tmuxNow.map((t) => t.name));
	// A dead agent's tmux session may be gone too: then there is no terminal to open.
	for (const a of agents) if (a.state === "dead" && a.tmux && !names.has(a.tmux)) a.tmux = undefined;
	const managed = new Set(agents.map((a) => a.tmux).filter(Boolean));
	const present = presences();
	let table: Procs | undefined;
	const unmanaged = tmuxNow
		.filter((t) => !managed.has(t.name) && t.name !== BOSS)
		.map((t) => ({
			...t,
			// A pi started by a script shows as its shell.
			command: /^(bash|zsh|sh|fish)$/.test(t.command) && piUnder(t.pid, (table ??= procs())) ? "pi" : t.command,
			adoptable: present.filter((x) => x.tmux === t.name),
			pending: pendingAdopts.get(t.name),
		}));
	return {
		now,
		home: home(),
		host: hostname(),
		user: userName(),
		version: VERSION,
		boss: agents.find((a) => a.name === BOSS) ?? null,
		bossTmux: hasSession(BOSS),
		workers: agents.filter((a) => a.name !== BOSS),
		questions: openQuestions(),
		chat: readJsonl<ChatLine>(p.chat(), 300),
		unmanaged,
		timeline: Object.fromEntries(agents.filter((a) => a.name !== BOSS).map((a) => [a.name, timeline(a.name, now)])),
		window: WINDOW,
		gpu,
		machine,
		secureUrl: PUBLIC_URL ?? listening?.https(),
	};
}

// A cheap fingerprint of everything the page shows, to push updates only on change.
function fingerprint(): string {
	const parts = [mtime(p.chat()), mtime(p.questions()), mtime(p.settings())];
	for (const n of listAgents()) parts.push(mtime(p.status(n)));
	parts.push(mtime(p.present()));
	try {
		for (const f of readdirSync(p.questions())) parts.push(mtime(join(p.questions(), f)));
	} catch {}
	return parts.join(",");
}

// ---------------------------------------------------------------- adopting

/** Sessions we typed /reload into, waiting for their pi to announce itself. */
const pendingAdopts = new Map<string, { name: string; since: number; error?: string }>();

function adopt(who: Presence, name: string) {
	writeJson(p.adopt(who.pid), { name });
	chat({ from: "act", worker: name, text: `adopted tmux session ${who.tmux} as ${name}` });
	send(BOSS, { from: "user", kind: "adopted", worker: name, text: `${userName()} adopted the running pi in tmux session ${who.tmux} (${who.cwd}).` });
}

function checkAdoptName(name: unknown): string | undefined {
	if (typeof name !== "string" || !NAME_RE.test(name) || name === BOSS) return "name: lowercase letters, digits and dashes";
	const existing = liveStatus(name);
	if (existing && existing.state !== "stopped" && existing.state !== "dead") return `a worker named ${name} is running`;
}

setInterval(() => {
	if (!pendingAdopts.size) return;
	const present = presences();
	for (const [session, a] of pendingAdopts) {
		const who = present.find((x) => x.tmux === session);
		if (who && !a.error) {
			pendingAdopts.delete(session);
			adopt(who, a.name);
			push();
		} else if (!a.error && Date.now() - a.since > 45_000) {
			a.error = "pi did not show up after /reload. Is ~/.pi/agent/extensions/perch.ts installed?";
			push();
		} else if (a.error && Date.now() - a.since > 180_000) {
			pendingAdopts.delete(session);
			push();
		}
	}
}, 1000);

// ---------------------------------------------------------------- dead agents

/** Lines of the user journal that report the OOM killer, from just before an agent's last heartbeat. */
function oomNear(ts: number): string[] {
	const sec = Math.round(ts / 1000);
	const r = spawnSync("journalctl", ["--user", "--no-pager", "-o", "short-iso-precise", "--since", `@${sec - 5}`, "--until", `@${sec + 180}`], {
		encoding: "utf8",
		timeout: 5000,
	});
	return (r.stdout || "").split("\n").filter((l) => /OOM killer|oom-kill/.test(l));
}

/** Why an agent's pi is gone, as far as we can tell. */
/** When this machine booted (ms). PERCH_BOOT_TIME (ms) pretends a reboot, for tests. */
const BOOT = (() => {
	if (process.env.PERCH_BOOT_TIME) return Number(process.env.PERCH_BOOT_TIME);
	try {
		return Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]) * 1000 || 0;
	} catch {
		return 0;
	}
})();

function deathReason(st: Status): string {
	const why: string[] = [];
	if (BOOT && st.heartbeat < BOOT) {
		const t = new Date(BOOT).toISOString().slice(0, 16).replace("T", " ");
		return `${hostname()} restarted (up again since ${t} UTC); pi was running before that${st.signal ? ` and was shut down with ${st.signal}` : ""}`;
	}
	const ex = readJson<{ code: number; ts: number }>(p.exit(st.name));
	const exited = ex && ex.ts >= st.started ? ex : undefined;
	const at = (l: string) => Date.parse(l.split(" ", 1)[0]);
	// An OOM kill counts if it happened when pi exited (run.sh wrote exit.json), or, when the whole
	// session went down with it (no exit.json), after pi's last sign of life.
	// Only kills in this agent's own scope, or in a tmux pane scope (agents started by older run.sh).
	const ooms = oomNear(st.heartbeat)
		.filter((l) => l.includes(`perch-${st.name}-`) || l.includes("tmux-spawn-"))
		.filter((l) => (exited ? Math.abs(exited.ts - at(l)) < 1500 : at(l) - st.heartbeat < 60_000));
	const own = ooms.find((l) => l.includes(`perch-${st.name}-`));
	const hhmm = (l: string) => l.slice(11, 16);
	if (own) why.push(`the out-of-memory killer killed it (${hhmm(own)} UTC)`);
	else if (ooms.length)
		why.push(`probably the out-of-memory killer: the journal shows an OOM kill at ${hhmm(ooms[0])} UTC${ooms[0].includes("tmux-spawn") ? ", which took a whole tmux session" : ""}`);
	if (st.signal) why.push(`pi was shut down with ${st.signal}${st.signal === "SIGHUP" ? " (its terminal went away)" : ""}`);
	else if (exited) why.push(exited.code === 137 ? "pi was killed with SIGKILL" : `pi exited with code ${exited.code}`);
	if (!ooms.length && !exited && !st.signal) why.push("its process disappeared without shutting down");
	why.push(!st.tmux || !hasSession(st.tmux) ? `its tmux session${st.tmux ? ` ${st.tmux}` : ""} is gone` : `its tmux session ${st.tmux} is still open`);
	return why.join("; ");
}

/** Agents whose pi vanished without a clean shutdown: mark them dead once, tell the boss and the user. */
function checkDead() {
	for (const name of listAgents()) {
		const st = readStatus(name);
		if (!st || st.state === "stopped" || st.state === "dead" || running(st)) continue;
		const reason = deathReason(st);
		const rebooted = BOOT > 0 && st.heartbeat < BOOT;
		const t = Date.now();
		// A resumed pi may have written its new status meanwhile (deathReason can take seconds).
		const now = readStatus(name);
		if (now?.pid !== st.pid || now.started !== st.started) continue;
		writeJson(p.status(name), { ...st, state: "dead", error: reason, updated: t });
		appendJsonl(p.events(name), { ts: t, state: "dead", headline: st.headline });
		chat({ from: "act", worker: name, text: `${name} died: ${reason}` });
		if (name !== BOSS)
			send(BOSS, {
				from: name,
				kind: "error",
				text: rebooted
					? `Its pi is gone: ${reason}. It was ${st.state}: "${st.headline}". Nothing restarts workers by itself after a restart: resume it if its work is still wanted (its conversation is kept) and tell it what happened; otherwise leave it.`
					: `Its pi is gone: ${reason}. Last headline: "${st.headline}". Bring it back with resume (its conversation is kept), and tell it what happened.`,
			});
		push();
	}
}
setInterval(checkDead, 5000);

// ---------------------------------------------------------------- server

const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
function push(event = "state") {
	if (!clients.size) return;
	const data = enc.encode(`event: ${event}\ndata: ${JSON.stringify(state())}\n\n`);
	for (const c of clients) {
		try {
			c.enqueue(data);
		} catch {
			clients.delete(c);
		}
	}
}
let last = "";
setInterval(() => {
	const f = fingerprint();
	if (f !== last) {
		last = f;
		push();
	}
}, 700);
setInterval(() => push(), 10_000); // ages, liveness, tmux, GPU

// Cross-origin isolation lets the speech model use threads; the rest is ordinary hygiene.
const HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { ...HEADERS, "cache-control": "no-store" } });
const bad = (msg: string) => json({ error: msg }, 400);

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".wasm": "application/wasm",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
/** A file under root, or undefined (no path tricks). */
function file(root: string, rel: string, cache: string): Response | undefined {
	const path = normalize(join(root, decodeURIComponent(rel)));
	if (!path.startsWith(`${root}/`) || !existsSync(path)) return undefined;
	return new Response(Bun.file(path), {
		headers: { ...HEADERS, "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": cache },
	});
}

/** Writes and terminals only from our own page: another site open in the user's browser must not
 * be able to post to the boss or type into a shell. Browsers always send Origin on POST and
 * websocket requests; a request without one comes from curl or a script on the tailnet. */
function sameOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return !req.headers.get("sec-fetch-site");
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
}

async function body(req: Request): Promise<any> {
	try {
		return await req.json();
	} catch {
		return {};
	}
}

let listening: Listening | undefined;
const app: Serve = (o) => Bun.serve<TermData, never>({
	...o,
	idleTimeout: 0,
	maxRequestBodySize: 64 << 20,
	websocket: {
		maxPayloadLength: 1 << 20,
		idleTimeout: 120,
		open: openTerm,
		message: termMessage,
		close: closeTerm,
	},
	async fetch(req, srv) {
		const url = new URL(req.url);
		const route = `${req.method} ${url.pathname}`;
		if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);

		if (url.pathname === "/api/term") {
			if (!sameOrigin(req)) return json({ error: "cross-origin terminal refused" }, 403);
			const d = termData(url);
			if (typeof d === "string") return bad(d);
			return srv.upgrade(req, { data: d }) ? undefined : bad("websocket upgrade failed");
		}
		if (req.method === "GET") {
			if (url.pathname.startsWith("/assets/")) return file(join(DIST, "assets"), url.pathname.slice(8), "public, max-age=300") ?? new Response("not found", { status: 404 });
			if (url.pathname.startsWith("/models/") || url.pathname.startsWith("/speech/"))
				return file(VOICE, url.pathname.slice(1), "public, max-age=31536000, immutable") ?? new Response("voice assets missing: bun scripts/prepare-voice.ts", { status: 404 });
			if (url.pathname.startsWith("/media/")) {
				const name = url.pathname.slice(7);
				return (MEDIA_RE.test(name) && file(p.media().replace(/\/$/, ""), name, "private, max-age=31536000, immutable")) || new Response("not found", { status: 404 });
			}
			if (url.pathname.startsWith("/fonts/")) return file(join(DIST, "fonts"), url.pathname.slice(7), "public, max-age=31536000, immutable") ?? new Response("not found", { status: 404 });
			if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") return file(DIST, url.pathname.slice(1), "no-cache")!;
			if (/^\/(icon\.svg|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon\.png)$/.test(url.pathname))
				return file(DIST, url.pathname.slice(1), "public, max-age=3600")!;
		}

		switch (route) {
			case "GET /":
			case "GET /index.html":
				return file(DIST, "index.html", "no-store")!;

			case "GET /api/history": {
				const text = history(url.searchParams.get("session") ?? "");
				return text === undefined ? bad("no such session") : json({ text });
			}

			case "GET /api/agent": {
				const name = url.searchParams.get("name") ?? "";
				if (!NAME_RE.test(name)) return bad("bad name");
				let brief = "";
				try {
					brief = readFileSync(p.brief(name), "utf8");
				} catch {}
				return json({ brief });
			}

			case "GET /api/state":
				return json(state());

			case "GET /api/events": {
				let ctl: ReadableStreamDefaultController;
				const stream = new ReadableStream({
					start(c) {
						ctl = c;
						clients.add(c);
						c.enqueue(enc.encode(`retry: 2000\nevent: state\ndata: ${JSON.stringify(state())}\n\n`));
					},
					cancel() {
						clients.delete(ctl);
					},
				});
				return new Response(stream, {
					headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
				});
			}

			// {text, images?: [{mimeType, data (base64)}]}: images reach the boss as image content.
			case "POST /api/chat": {
				const { text, images } = await body(req);
				const t = typeof text === "string" ? text.trim() : "";
				const imgs = Array.isArray(images) ? images : [];
				if (imgs.length > 8) return bad("at most 8 images per message");
				const bytes = imgs.map((i) => (IMAGE_TYPES[i?.mimeType] && typeof i.data === "string" ? Buffer.from(i.data, "base64") : undefined));
				if (bytes.some((b) => !b || b.length < 16 || b.length > 12 << 20)) return bad("images must be png, jpg, webp or gif, under 12 MB");
				if (!t && !bytes.length) return bad("empty message");
				const names = bytes.map((b, i) => saveImage(b!, imgs[i].mimeType));
				chat({ from: "user", text: t, images: names.length ? names : undefined });
				const paths = names.map((n) => p.media(n));
				// The note names the files: the boss can forward them, and an older boss can still read them.
				send(BOSS, { from: "user", kind: "user", text: (t || "(see the image)") + imageNote(paths), images: paths });
				push();
				return json({ ok: true });
			}

			case "POST /api/tap": {
				const { worker } = await body(req);
				if (!NAME_RE.test(worker ?? "") || !liveStatus(worker)) return bad("unknown worker");
				chat({ from: "user", text: `How is ${worker} doing?`, worker });
				send(BOSS, { from: "user", kind: "tap", worker, text: "" });
				push();
				return json({ ok: true, ts: Date.now() });
			}

			case "POST /api/answer": {
				const { id, text } = await body(req);
				const q = readJson<Question>(p.question(String(id)));
				if (!q || q.answered) return bad("no open question with that id");
				if (typeof text !== "string" || !text.trim()) return bad("empty answer");
				writeJson(p.question(q.id), { ...q, answered: { ts: Date.now(), text: text.trim(), how: "button" } });
				chat({ from: "user", text: text.trim(), worker: q.worker, ref: q.id });
				send(BOSS, { from: "user", kind: "user_answer", ref: q.id, worker: q.worker, text: `${text.trim()}\n(Your question was: ${q.question})` });
				push();
				return json({ ok: true });
			}

			case "GET /api/settings":
				return json({ settings: loadSettings(), guidance: loadGuidance(), defaultGuidance: defaultGuidance(), accountName: accountName(), models: models() });

			case "POST /api/settings": {
				const { settings, guidance } = await body(req);
				const cur = loadSettings();
				const next: Settings = {
					...cur,
					...(settings ?? {}),
					boss: { ...cur.boss, ...settings?.boss },
					worker: { ...cur.worker, ...settings?.worker },
					overrides: settings?.overrides ?? cur.overrides,
				};
				if (typeof next.memoryMax !== "string" || !/^(|\d{1,3}%|\d+(\.\d+)?[KMGT]?)$/.test(next.memoryMax.trim()))
					return bad("memory limit: a percentage like 50%, a size like 24G, or empty for none");
				if (typeof next.userName !== "string" || !/^[^[\]\n\r]{0,40}$/.test(next.userName)) return bad("name: at most 40 characters, no brackets");
				next.userName = next.userName.trim();
				// Guidance left at the default stays the default (it names the user, so it follows a new name).
				const before = defaultGuidance();
				writeJson(p.settings(), next);
				if (typeof guidance === "string") writeText(p.guidance(), guidance.trim() === before.trim() ? "" : `${guidance.trim()}\n`);
				send(BOSS, { from: "user", kind: "settings", text: "" });
				push();
				return json({ ok: true, settings: next });
			}

			// {pid, name}: adopt a pi that has perch loaded (dormant).
			// {session, name}: a pi without perch: type /reload into it if that is safe, adopt when it shows up.
			case "POST /api/adopt": {
				const { pid, session, name } = await body(req);
				const nameErr = checkAdoptName(name);
				if (nameErr) return bad(nameErr);
				const present = presences();
				const who = pid !== undefined ? present.find((x) => x.pid === Number(pid)) : present.find((x) => x.tmux === session);
				if (who) {
					adopt(who, name);
					push();
					return json({ ok: true, adopted: who.tmux });
				}
				if (pid !== undefined) return bad("that pi session is gone or was already adopted");
				if (typeof session !== "string" || !hasSession(session)) return bad("no such tmux session");
				const r = reloadPi(session);
				if (!r.ok) return bad(`Did not touch it: ${r.why}.`);
				pendingAdopts.set(session, { name, since: Date.now() });
				push();
				return json({ ok: true, reloading: session });
			}

			case "POST /api/resume": {
				const { name } = await body(req);
				if (!NAME_RE.test(name ?? "")) return bad("unknown agent");
				const r = resume(name);
				if (!r.ok) return bad(r.error ?? "could not resume");
				chat({ from: "act", worker: name, text: `${userName()} resumed ${name}` });
				push();
				return json({ ok: true, session: r.session });
			}

			case "POST /api/boss/start": {
				const b = readStatus(BOSS);
				if (b && running(b)) return json({ ok: true, already: true });
				if (b) {
					const r = resume(BOSS);
					return r.ok ? json({ ok: true }) : bad(r.error ?? "could not resume the boss");
				}
				if (hasSession(BOSS)) return bad("a tmux session named boss exists but runs no perch boss");
				const s = loadSettings();
				const r = launch({ name: BOSS, role: "boss", choice: s.boss, startDir: s.startDir });
				return r.ok ? json({ ok: true }) : bad(r.error ?? "could not start the boss");
			}
		}
		return new Response("not found", { status: 404 });
	},
});

listening = listen(app, HOST, PORT);
console.log(`perch web on ${listening.http}/ (home ${home()})`);
if (LOCAL_PORT) {
	app({ hostname: "127.0.0.1", port: LOCAL_PORT });
	console.log(`perch web on http://127.0.0.1:${LOCAL_PORT}/ for tailscale serve${PUBLIC_URL ? ` (${PUBLIC_URL})` : ""}`);
}
