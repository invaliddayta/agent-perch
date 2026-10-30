/**
 * perch: one boss, many workers, all pi. Load with `pi -e perch.ts`; the role comes from
 * PERCH_ROLE (boss | worker) and PERCH_NAME, which run.sh sets. Without a role it stays dormant:
 * it only announces itself so the dashboard can adopt the session later.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boss } from "./boss.ts";
import { dormant } from "./dormant.ts";
import { BOSS, listAgents, NAME_RE, type Role, readStatus, recallRole, rememberRole } from "./store.ts";
import { worker } from "./worker.ts";

/** This process's role from before a reload by older perch code, which kept it nowhere: its status file has our pid. */
function fromStatus(): Role | undefined {
	const since = Date.now() - process.uptime() * 1000;
	for (const n of listAgents()) {
		const s = readStatus(n);
		if (s?.pid === process.pid && s.started >= since - 5000) return { role: s.role, name: s.name };
	}
}

export default function (pi: ExtensionAPI) {
	const env = process.env.PERCH_ROLE;
	const envName = process.env.PERCH_NAME;
	// Not for child processes: a subagent this pi starts must not take over its role.
	delete process.env.PERCH_ROLE;
	delete process.env.PERCH_NAME;
	const r: Role | undefined =
		env === "boss" || env === "worker" ? { role: env, name: env === "boss" ? BOSS : (envName ?? "") } : (recallRole() ?? (env ? undefined : fromStatus()));
	if (r?.role === "boss") {
		rememberRole(r);
		boss(pi);
	} else if (r?.role === "worker" && NAME_RE.test(r.name) && r.name !== BOSS) {
		rememberRole(r);
		worker(pi, r.name);
	} else if (!env && process.env.PERCH_DORMANT !== "off") dormant(pi);
}
