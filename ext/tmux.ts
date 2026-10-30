/**
 * tmux helpers. PERCH_TMUX_SOCKET selects a separate tmux server (tests); unset means
 * the default server, the one the user works in.
 */
import { spawnSync } from "node:child_process";

const base = () => (process.env.PERCH_TMUX_SOCKET ? ["-L", process.env.PERCH_TMUX_SOCKET] : []);

export function tmux(...args: string[]): { ok: boolean; out: string; err: string } {
	const r = spawnSync("tmux", [...base(), ...args], { encoding: "utf8" });
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/**
 * tmux new-session. When no tmux server runs yet this starts one, so it gets its own systemd scope:
 * otherwise the server, and every session in it (the user's too), would live in the cgroup of whatever
 * started it (the dashboard's or the boss's service) and could be killed with that unit.
 */
export function newSession(...args: string[]): { ok: boolean; out: string; err: string } {
	if (!tmux("list-sessions", "-F", "#{session_name}").ok) {
		const r = spawnSync(
			"systemd-run",
			["--user", "--scope", "--quiet", "--collect", "--unit", `perch-tmux-${Date.now()}`, "tmux", ...base(), "new-session", ...args],
			{ encoding: "utf8", env: { XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 1000}`, ...process.env } },
		);
		if (r.status === 0) return { ok: true, out: (r.stdout ?? "").trim(), err: "" };
		// No systemd user manager (or no scope allowed): start it the plain way below.
	}
	return tmux("new-session", ...args);
}

export const hasSession = (name: string) => tmux("has-session", "-t", `=${name}`).ok;

export interface TmuxSession {
	name: string;
	command: string; // foreground command of the active pane
	path: string;
	pid: number; // pane pid
	created: number; // ms
	activity: number; // ms
}

export function sessions(): TmuxSession[] {
	const r = tmux(
		"list-sessions",
		"-F",
		"#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{session_created}\t#{session_activity}\t#{session_group}",
	);
	if (!r.ok) return [];
	return r.out
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t"))
		// Sessions named __* are helpers (the dashboard's terminal viewers): not shown.
		.filter(([name]) => !name.startsWith("__"))
		.map(([name, command, path, pid, created, activity]) => ({
			name,
			command,
			path,
			pid: Number(pid),
			created: Number(created) * 1000,
			activity: Number(activity) * 1000,
		}));
}

/** The tmux session this process runs in, if any (uses the pane tmux gave us, on its own server). */
export function ownSession(): string | undefined {
	if (process.env.PERCH_SESSION) return process.env.PERCH_SESSION;
	if (!process.env.TMUX || !process.env.TMUX_PANE) return undefined;
	const r = spawnSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#S"], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
