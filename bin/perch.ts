#!/usr/bin/env bun
/**
 * perch CLI (bun bin/perch.ts <command>).
 *   perch install    set up the dashboard and the boss as systemd user units (see bin/install.ts)
 *   perch uninstall  remove the units and the pi extension loader (not the data)
 *   perch boss       start the boss in tmux session "boss", resuming its conversation (or say it's running);
 *                    --wait-online waits up to 3 min for the network first (at boot)
 *   perch status     one line per agent
 *   perch say <msg>  send a chat message to the boss, as the user
 *   perch web        run the dashboard (PERCH_HOST, PERCH_PORT, ...; see web/server.ts)
 *   perch runscripts rewrite every agent's run.sh with the current launcher (after an upgrade)
 */
import { lookup } from "node:dns/promises";
import { launch, resume, writeRun } from "../ext/launch.ts";
import { BOSS, chat, home, listAgents, liveStatus, loadSettings, readStatus, running, send } from "../ext/store.ts";
import { hasSession } from "../ext/tmux.ts";

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
	case "install":
		process.exit((await import("./install.ts")).install(rest));
		break;
	case "uninstall":
		process.exit((await import("./install.ts")).uninstall());
		break;
	case "boss": {
		if (rest.includes("--wait-online")) await online(180);
		const b = readStatus(BOSS);
		if (b && running(b)) {
			console.log(`boss is running (pid ${b.pid}): tmux attach -t ${b.tmux ?? BOSS}`);
			break;
		}
		const s = loadSettings();
		if (b) {
			// Started before (e.g. before a reboot): same conversation, in the old tmux session if it is at a prompt.
			const r = resume(BOSS);
			if (!r.ok) {
				console.error(r.error);
				process.exit(1);
			}
			console.log(`boss resumed (${describe(s.boss)}): tmux attach -t ${BOSS}`);
			break;
		}
		if (hasSession(BOSS)) {
			console.error(`a tmux session named ${BOSS} exists but runs no perch boss`);
			process.exit(1);
		}
		const r = launch({ name: BOSS, role: "boss", choice: s.boss, startDir: s.startDir });
		if (!r.ok) {
			console.error(r.error);
			process.exit(1);
		}
		console.log(`boss started (${describe(s.boss)}), home ${home()}: tmux attach -t ${BOSS}`);
		break;
	}
	case "status":
		for (const n of listAgents()) {
			const s = liveStatus(n);
			if (s) console.log(`${s.name.padEnd(16)} ${s.state.padEnd(8)} ${s.completed}/${s.milestones.length}  ${s.headline}`);
		}
		break;
	case "say": {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error("usage: perch say <message>");
			process.exit(1);
		}
		chat({ from: "user", text });
		send(BOSS, { from: "user", kind: "user", text });
		break;
	}
	case "web":
		await import("../web/server.ts");
		break;
	case "runscripts":
		for (const n of listAgents()) {
			const o = writeRun(n);
			console.log(`${n.padEnd(16)} ${o.role} in ${o.startDir}${o.sessionFile ? ` (session ${o.sessionFile})` : ""}`);
		}
		break;
	default:
		console.log("usage: perch install | uninstall | boss | status | say <message> | web | runscripts");
}

function describe(c: { model: string; thinking: string }) {
	return `${c.model || "pi's default model"}${c.thinking ? ` · ${c.thinking}` : ""}`;
}

/** Wait until names resolve (the network is up), at most `secs`. */
async function online(secs: number) {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		for (const host of ["api.anthropic.com", "api.openai.com", "github.com"])
			if (await lookup(host).then(() => true, () => false)) return;
		await Bun.sleep(2000);
	}
	console.log(`no network after ${secs} s; starting the boss anyway`);
}
