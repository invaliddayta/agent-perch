/**
 * `perch install`: set perch up for this user, from this checkout.
 *   - checks bun, tmux, pi and systemd,
 *   - installs the page's dependencies if they are missing,
 *   - puts a small loader into pi's extensions dir, so every pi has perch (dormant until it gets a role),
 *   - writes two systemd user units, perch-web (the dashboard) and perch-boss (starts or resumes the boss),
 *     enables them and starts them (an already running dashboard is restarted; agents keep running).
 * The options are kept in PERCH_HOME/install.json, so running `perch install` again (after a
 * `git pull`) keeps them. `perch uninstall` removes the units and the loader, not the data.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GLOBAL_EXT } from "../ext/launch.ts";
import { home, readJson, writeJson, writeText } from "../ext/store.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const UNITS = ["perch-web", "perch-boss"] as const;
const DEFAULT_HOME = join(homedir(), ".perch");
const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user");

export interface InstallOptions {
	/** Address the dashboard listens on. Default: this machine's Tailscale IPv4, else 127.0.0.1. */
	host: string;
	port: number;
	/** The address people should use, if a proxy (e.g. `tailscale serve`) puts it elsewhere. */
	publicUrl?: string;
}

const run = (cmd: string, args: string[]) => {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || String(r.error ?? "") };
};
const version = (s: string) => (s.match(/(\d+)\.(\d+)/) ?? []).slice(1, 3).map(Number) as [number, number];
const atLeast = ([a, b]: [number, number], [x, y]: [number, number]) => a > x || (a === x && b >= y);

/** This machine's Tailscale IPv4, if Tailscale runs. */
export function tailscaleIp(): string | undefined {
	const r = run("tailscale", ["ip", "-4"]);
	return r.ok ? r.out.split("\n")[0] || undefined : undefined;
}

/** What is missing or too old. Empty when perch can run. */
export function checks(): { errors: string[]; notes: string[] } {
	const errors: string[] = [];
	const notes: string[] = [];
	if (!atLeast(version(Bun.version), [1, 2])) errors.push(`bun ${Bun.version} is too old: perch needs bun 1.2 or newer`);
	const tmux = run("tmux", ["-V"]);
	if (!tmux.ok) errors.push("tmux is missing: install tmux 3.2 or newer");
	else if (!atLeast(version(tmux.out), [3, 2])) errors.push(`${tmux.out} is too old: perch needs tmux 3.2 or newer`);
	const pi = run("pi", ["--version"]);
	if (!pi.ok) errors.push("pi is missing: install pi (https://pi.dev), start it once and log in to a provider (/login)");
	else if (!atLeast(version(pi.out), [1, 1])) errors.push(`pi ${pi.out} is too old: perch needs pi 1.1 or newer`);
	if (!run("systemctl", ["--user", "show-environment"]).ok) errors.push("no systemd user manager (systemctl --user): perch install needs one");
	const linger = run("loginctl", ["show-user", userInfo().username, "-p", "Linger", "--value"]);
	if (linger.ok && linger.out !== "yes")
		notes.push(`Linger is off: perch stops when you log out and starts only when you log in. To keep it running: loginctl enable-linger ${userInfo().username}`);
	if (!run("tailscale", ["version"]).ok)
		notes.push("No Tailscale: the dashboard listens on 127.0.0.1 only. For your phone, and for HTTPS (needed for the microphone), see the README.");
	return { errors, notes };
}

/** The pi extension loader. Agents of another (test) home load the perch they were started with. */
export function loader(ext = join(ROOT, "ext/perch.ts"), perchHome = home()): string {
	const h = perchHome.replace(/\/+$/, "");
	return `/**
 * perch (${ROOT}): loads the perch extension into every pi. Written by \`perch install\`.
 * Without a role perch is dormant and only announces itself, so the dashboard can adopt the session.
 * Remove this file (or run \`perch uninstall\`) to turn that off; boss and workers then load perch with -e.
 */
export default async function perch(pi: unknown) {
	const home = (process.env.PERCH_HOME || ${JSON.stringify(h)}).replace(/\\/+$/, "");
	const other = home !== ${JSON.stringify(h)} && process.env.PERCH_EXT;
	const mod = await import(other || ${JSON.stringify(ext)});
	return mod.default(pi);
}
`;
}

const envLines = (env: Record<string, string | undefined>) =>
	Object.entries(env)
		.filter(([, v]) => v)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");

/** The two unit files. PATH is the installer's, so the services find the same pi, tmux and bun. */
export function unitFiles(o: InstallOptions, root = ROOT, bun = process.execPath, path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", perchHome = home()) {
	const common = envLines({ PATH: path, PERCH_HOME: perchHome === DEFAULT_HOME ? undefined : perchHome });
	const url = o.publicUrl || `http://${o.host}:${o.port}/`;
	return {
		"perch-web": `[Unit]
Description=perch dashboard: ${url}

[Service]
Type=simple
WorkingDirectory=${root}
${common}
${envLines({ PERCH_HOST: o.host, PERCH_PORT: String(o.port), PERCH_PUBLIC_URL: o.publicUrl })}
ExecStart=${bun} bin/perch.ts web
Restart=always
RestartSec=5
# Only this process: the boss and the workers live in tmux and keep running across restarts.
KillMode=process

[Install]
WantedBy=default.target
`,
		"perch-boss": `[Unit]
Description=perch boss: start or resume the boss in tmux session "boss"
Wants=perch-web.service
After=perch-web.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${root}
${common}
# --wait-online: at boot, wait (at most 3 min) for the network, so the boss's first turn reaches its model.
ExecStart=${bun} bin/perch.ts boss --wait-online
# The tmux server and every pi have their own scopes; never kill anything when this unit stops.
KillMode=process

[Install]
WantedBy=default.target
`,
	};
}

function parse(argv: string[]): { opts: Partial<InstallOptions>; dryRun: boolean; noStart: boolean } {
	const opts: Partial<InstallOptions> = {};
	let dryRun = false;
	let noStart = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "--host") opts.host = val();
		else if (a === "--port") opts.port = Number(val());
		else if (a === "--public-url") opts.publicUrl = val();
		else if (a === "--dry-run") dryRun = true;
		else if (a === "--no-start") noStart = true;
		else throw new Error(`unknown option ${a}`);
	}
	return { opts, dryRun, noStart };
}

export function install(argv: string[]): number {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (e) {
		console.error(`${(e as Error).message}\nusage: perch install [--host ADDRESS] [--port N] [--public-url URL] [--no-start] [--dry-run]`);
		return 2;
	}
	const saved = readJson<Partial<InstallOptions>>(join(home(), "install.json")) ?? {};
	const o: InstallOptions = {
		host: parsed.opts.host ?? saved.host ?? tailscaleIp() ?? "127.0.0.1",
		port: parsed.opts.port ?? saved.port ?? 4320,
		publicUrl: parsed.opts.publicUrl ?? saved.publicUrl,
	};
	if (o.publicUrl === "") o.publicUrl = undefined;
	if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return fail(`--port: ${o.port} is not a port`);
	if (["0.0.0.0", "::", "[::]", "*"].includes(o.host))
		return fail("perch has no login: anyone who reaches the dashboard can type into your terminals. Give it 127.0.0.1 or a private (e.g. Tailscale) address, not all interfaces.");

	const { errors, notes } = checks();
	for (const e of errors) console.error(`✗ ${e}`);
	if (errors.length) return 1;

	const units = unitFiles(o);
	if (parsed.dryRun) {
		console.log(`# ${GLOBAL_EXT}\n${loader()}`);
		for (const [n, text] of Object.entries(units)) console.log(`# ${join(unitDir(), `${n}.service`)}\n${text}`);
		return 0;
	}

	if (!existsSync(join(ROOT, "web/node_modules"))) {
		console.log("installing the page's dependencies (bun install in web/)");
		const r = spawnSync(process.execPath, ["install", "--frozen-lockfile"], { cwd: join(ROOT, "web"), stdio: "inherit" });
		if (r.status !== 0) return fail("bun install in web/ failed");
	}
	mkdirSync(home(), { recursive: true });
	writeJson(join(home(), "install.json"), o);
	mkdirSync(dirname(GLOBAL_EXT), { recursive: true });
	writeText(GLOBAL_EXT, loader());
	console.log(`✓ pi extension loader: ${GLOBAL_EXT}`);
	mkdirSync(unitDir(), { recursive: true });
	for (const [n, text] of Object.entries(units)) writeText(join(unitDir(), `${n}.service`), text);
	console.log(`✓ systemd user units: ${UNITS.map((u) => `${u}.service`).join(", ")} in ${unitDir()}`);

	const sc = (...args: string[]) => {
		const r = run("systemctl", ["--user", ...args]);
		if (!r.ok) console.error(`systemctl --user ${args.join(" ")}: ${r.err}`);
		return r.ok;
	};
	if (!sc("daemon-reload") || !sc("enable", ...UNITS.map((u) => `${u}.service`))) return 1;
	if (!parsed.noStart) {
		// The dashboard: start, or restart for new code and settings (agents keep running). The boss: start if it is not up.
		if (!sc(run("systemctl", ["--user", "is-active", "--quiet", "perch-web"]).ok ? "restart" : "start", "perch-web.service")) return 1;
		if (!sc("start", "perch-boss.service")) return 1;
	}

	const url = o.publicUrl || `http://${o.host}:${o.port}/`;
	console.log(`
perch is ${parsed.noStart ? "installed (not started)" : "running"}.
  dashboard:  ${url}${o.host !== "127.0.0.1" ? `\n              http://127.0.0.1:${o.port}/ (this machine)` : ""}
  boss:       tmux attach -t boss       (or talk to it in the dashboard's chat)
  from a shell: bun ${join(ROOT, "bin/perch.ts")} say "hello"
  data:       ${home()}
  logs:       journalctl --user -u perch-web -u perch-boss`);
	for (const n of notes) console.log(`\nnote: ${n}`);
	return 0;
}

export function uninstall(): number {
	run("systemctl", ["--user", "disable", "--now", ...UNITS.map((u) => `${u}.service`)]);
	for (const u of UNITS) rmSync(join(unitDir(), `${u}.service`), { force: true });
	run("systemctl", ["--user", "daemon-reload"]);
	rmSync(GLOBAL_EXT, { force: true });
	console.log(`Removed the units and ${GLOBAL_EXT}.
The boss and the workers still run in tmux (tmux ls); end them with tmux kill-session -t <name>.
Your data stays in ${home()}.`);
	return 0;
}

function fail(msg: string): number {
	console.error(`✗ ${msg}`);
	return 1;
}
