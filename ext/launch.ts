/**
 * Start an agent (boss or worker) as an interactive pi in its own tmux session.
 * Each agent gets a run.sh that resumes its own conversation, so a crashed or ended
 * agent comes back with `bash run.sh` (or the boss's spawn/restart).
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOSS, expandHome, home, loadSettings, type ModelChoice, p, readStatus, readText, running, writeText } from "./store.ts";
import { hasSession, newSession, tmux } from "./tmux.ts";

export const EXT = process.env.PERCH_EXT || join(dirname(fileURLToPath(import.meta.url)), "perch.ts");
/** pi's config dir (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
export const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
/** The loader `perch install` puts there, so every pi has perch (dormant until it gets a role). */
export const GLOBAL_EXT = join(PI_DIR, "extensions/perch.ts");

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface LaunchOptions {
	name: string;
	role: "boss" | "worker";
	choice: ModelChoice;
	startDir: string;
	/** First message for a new conversation (ignored when resuming). */
	prompt?: string;
	/** Resume this session file instead of the agent's own session dir (adopting). */
	sessionFile?: string;
}

export function runScript(o: LaunchOptions): string {
	const args = (process.env.PERCH_PI_ARGS || "").split(/\s+/).filter(Boolean);
	const extra = args.map(q).join(" ");
	// With the global loader, -e would load perch twice; unless extensions are off (tests run pi bare).
	const viaE = !existsSync(GLOBAL_EXT) || args.includes("--no-extensions") || args.includes("-ne");
	const mem = (loadSettings().memoryMax || "").trim();
	// Extra systemd properties for the scope (tests: MemorySwapMax=0 so a small limit bites at once).
	const props = (process.env.PERCH_SCOPE_PROPS || "").split(/\s+/).filter(Boolean).map((x) => ` -p ${q(x)}`).join("");
	const common = [
		'"${scope[@]}"',
		"pi",
		o.choice.model ? `--model ${q(o.choice.model)}` : "",
		o.choice.thinking ? `--thinking ${q(o.choice.thinking)}` : "",
		"--session-dir",
		q(p.sessionDir(o.name)),
		viaE ? `-e ${q(EXT)}` : "",
		extra,
	]
		.filter(Boolean)
		.join(" ");
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		PERCH_HOME: home(),
		PERCH_ROLE: o.role,
		PERCH_NAME: o.name,
		PERCH_SESSION: o.name,
		PERCH_EXT: EXT,
		PERCH_TMUX_SOCKET: process.env.PERCH_TMUX_SOCKET,
		PERCH_PI_ARGS: process.env.PERCH_PI_ARGS,
		PERCH_SCOPE_PROPS: process.env.PERCH_SCOPE_PROPS,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	const exports = Object.entries(env)
		.filter(([, v]) => v)
		.map(([k, v]) => `export ${k}=${q(v as string)}`)
		.join("\n");
	const start = o.sessionFile
		? `${common} --session ${q(o.sessionFile)}`
		: `if ls ${q(p.sessionDir(o.name))}/*.jsonl >/dev/null 2>&1; then
  ${common} --continue
else
  ${common} --name ${q(o.name)}${o.prompt ? ` ${q(o.prompt)}` : ""}
fi`;
	return `#!/usr/bin/env bash
# perch ${o.role} "${o.name}". Run again to resume the same conversation.
${exports}
cd ${q(expandHome(o.startDir))} || cd ~
# pi gets its own systemd scope. If a command it runs eats the memory, the kernel kills that
# command and pi carries on (OOMPolicy=continue); MemoryMax keeps one agent from taking the machine.
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
scope=()
if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet --collect true >/dev/null 2>&1; then
  scope=(systemd-run --user --scope --quiet --collect --unit "perch-${o.name}-$(date +%s)" -p OOMPolicy=continue${mem ? ` -p MemoryMax=${q(mem)}` : ""}${props})
fi
${start}
code=$?
printf '{"code":%d,"ts":%s}\\n' "$code" "$(date +%s%3N)" > ${q(p.exit(o.name))}
echo
echo "[perch] pi exited ($code). Resume: bash ${q(p.run(o.name))}"
exec bash
`;
}

/** Start options for an agent that ran before, from its old run.sh or its pi session file. */
function previous(name: string): LaunchOptions {
	const s = loadSettings();
	const st = readStatus(name);
	const old = readText(p.run(name), "");
	const role = st?.role ?? (name === BOSS ? "boss" : "worker");
	// A worker comes back on the model it was running, unless the user set one for it.
	const ran = st?.model ? { model: st.model, thinking: st.thinking ?? s.worker.thinking } : undefined;
	const choice = role === "boss" ? s.boss : (s.overrides[name] ?? ran ?? s.worker);
	const sessionFile = old.match(/--session '([^']+)'/)?.[1] ?? (old ? undefined : st?.sessionFile);
	let startDir = old.match(/^cd '([^']*)' \|\| cd ~$/m)?.[1];
	if (!startDir && sessionFile) {
		try {
			startDir = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]).cwd;
		} catch {}
	}
	return { name, role, choice, startDir: startDir || s.startDir, sessionFile };
}

/** Rewrite an existing agent's run.sh with the current launcher (settings, OOM-safe scope). Running pis are not affected. */
export function writeRun(name: string): LaunchOptions {
	const o = previous(name);
	writeText(p.run(name), runScript(o)); // atomic rename: a bash running the old file keeps reading the old file
	chmodSync(p.run(name), 0o755);
	return o;
}

/**
 * Start an agent again after its pi died: rewrite run.sh (current settings, OOM-safe scope) and
 * run it, in its old tmux session if that is still there at a shell prompt, else in a new one.
 */
export function resume(name: string): { ok: boolean; error?: string; session?: string } {
	const st = readStatus(name);
	if (st && running(st)) return { ok: false, error: `${name} is running (pid ${st.pid})` };
	if (!st && !existsSync(p.run(name))) return { ok: false, error: `no agent named ${name}` };
	const o = writeRun(name);
	const session = st?.tmux || name;
	const cmd = `bash ${q(p.run(name))}`;
	if (hasSession(session)) {
		const panes = tmux("list-panes", "-t", `=${session}:`, "-F", "#{pane_current_command}").out.split("\n");
		if (panes.length !== 1 || !/^(bash|zsh|sh|fish)$/.test(panes[0]))
			return { ok: false, error: `tmux session ${session} is busy (${panes.join(", ")}); resume it there by hand: ${cmd}` };
		tmux("send-keys", "-t", `=${session}:`, "-l", cmd);
		tmux("send-keys", "-t", `=${session}:`, "Enter");
		return { ok: true, session };
	}
	const r = newSession("-d", "-s", session, "-x", "200", "-y", "50", "-c", expandHome(o.startDir), cmd);
	return r.ok ? { ok: true, session } : { ok: false, error: r.err || "tmux new-session failed" };
}

/** Write run.sh and start it in a detached tmux session named after the agent. */
export function launch(o: LaunchOptions): { ok: boolean; error?: string } {
	if (hasSession(o.name)) return { ok: false, error: `tmux session "${o.name}" already exists` };
	writeText(p.run(o.name), runScript(o));
	chmodSync(p.run(o.name), 0o755);
	const r = newSession("-d", "-s", o.name, "-x", "200", "-y", "50", "-c", expandHome(o.startDir), `bash ${q(p.run(o.name))}`);
	return r.ok ? { ok: true } : { ok: false, error: r.err || "tmux new-session failed" };
}
