/**
 * The perch file layout, shared by the pi extension (boss and workers) and the web server.
 * Everything is a plain file under PERCH_HOME (default ~/.perch), written atomically:
 *
 *   settings.json             models, thinking levels, start dir
 *   guidance.md               when the boss should ask the user (plain text)
 *   models.json               models pi can use, written by the boss at startup
 *   chat.jsonl                what the user sees in the boss chat
 *   questions/<id>.json       questions the boss put to the user
 *   media/<id>.<ext>          images the user sent (or the boss forwarded), shown in the chat
 *   agents/<name>/status.json state, headline, milestones (written by that agent only)
 *   agents/<name>/events.jsonl state/headline history (timeline)
 *   agents/<name>/brief.md    a worker's brief (written by the boss)
 *   agents/<name>/session/    the agent's pi session files
 *   agents/<name>/inbox/      messages to the agent, one file each
 *   agents/<name>/inbox.log   messages it has taken from the inbox
 *   agents/<name>/run.sh      starts (and resumes) the agent; written by the launcher
 *   agents/<name>/exit.json   pi's exit code, written by run.sh when pi exits
 *   present/<pid>.json        pi sessions with perch loaded but no role (adoptable)
 *   tls/                      the dashboard's certificate (tailscale cert)
 *
 * Only Node built-ins: the extension runs under pi (jiti), the server under Bun.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const home = () => process.env.PERCH_HOME || join(homedir(), ".perch");
export const BOSS = "boss";
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const p = {
	settings: () => join(home(), "settings.json"),
	guidance: () => join(home(), "guidance.md"),
	models: () => join(home(), "models.json"),
	chat: () => join(home(), "chat.jsonl"),
	questions: () => join(home(), "questions"),
	question: (id: string) => join(home(), "questions", `${id}.json`),
	media: (name = "") => join(home(), "media", name),
	agents: () => join(home(), "agents"),
	agent: (n: string) => join(home(), "agents", n),
	status: (n: string) => join(home(), "agents", n, "status.json"),
	events: (n: string) => join(home(), "agents", n, "events.jsonl"),
	brief: (n: string) => join(home(), "agents", n, "brief.md"),
	run: (n: string) => join(home(), "agents", n, "run.sh"),
	exit: (n: string) => join(home(), "agents", n, "exit.json"), // written by run.sh when pi exits
	sessionDir: (n: string) => join(home(), "agents", n, "session"),
	inbox: (n: string) => join(home(), "agents", n, "inbox"),
	inboxLog: (n: string) => join(home(), "agents", n, "inbox.log"),
	present: () => join(home(), "present"),
	presence: (pid: number) => join(home(), "present", `${pid}.json`),
	adopt: (pid: number) => join(home(), "adopt", `${pid}.json`),
};

/** A pi session that has perch loaded but no role yet, so it can be adopted. */
export interface Presence {
	pid: number;
	tmux?: string;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	model?: string;
	started: number;
}

export function presences(): Presence[] {
	let files: string[];
	try {
		files = readdirSync(p.present()).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	return files.map((f) => readJson<Presence>(join(p.present(), f))).filter((x): x is Presence => !!x && running(x));
}

// ---------------------------------------------------------------- types

/** stopped: pi shut down cleanly. dead: its process is gone without shutting down (killed, crashed, OOM). */
export type State = "working" | "idle" | "asking" | "done" | "error" | "stopped" | "dead";

export interface Status {
	name: string;
	role: "boss" | "worker";
	state: State;
	headline: string;
	milestones: string[];
	completed: number; // milestones done
	started: number; // ms
	updated: number; // last state/headline/progress change
	heartbeat: number; // last sign of life
	pid: number;
	tmux?: string;
	model?: string; // provider/id
	thinking?: string;
	cost: number; // USD, this session
	tokens: number;
	context?: number; // percent of the context window in use
	activity: number[]; // tool calls per 5-minute bucket, oldest first, last bucket ends at activityAt
	activityAt: number;
	pending: string[]; // ids of questions this worker has open with the boss
	sessionFile?: string;
	error?: string;
	signal?: string; // pi was shut down by this signal (nobody asked it to stop)
}

export type MsgKind =
	| "message" // boss -> worker: instruction
	| "answer" // boss -> worker: answer to a question (ref)
	| "stop" // boss -> worker: abort the current run
	| "end" // boss -> worker: shut down
	| "question" // worker -> boss
	| "settled" // worker -> boss: stopped without asking
	| "done" // worker -> boss: reported finished
	| "error" // worker -> boss: run ended in an error
	| "user" // web -> boss: chat message
	| "tap" // web -> boss: explain this worker
	| "user_answer" // web -> boss: the user answered a question (ref)
	| "settings" // web -> boss/worker: settings changed
	| "adopted"; // web -> boss: the user adopted a running pi as a worker

export interface Msg {
	id: string;
	ts: number;
	from: string;
	kind: MsgKind;
	text: string;
	ref?: string; // question id
	worker?: string;
	urgent?: boolean;
	images?: string[]; // absolute paths of images that go with the text
	meta?: Record<string, unknown>;
}

export interface Question {
	id: string;
	ts: number;
	worker?: string;
	question: string;
	options?: string[];
	context?: string;
	answered?: { ts: number; text: string; how?: "button" | "chat" | "moot" };
}

export interface ChatLine {
	ts: number;
	from: "user" | "boss" | "act";
	text: string;
	worker?: string;
	via?: string; // "terminal" when the user typed into the boss TUI
	ref?: string; // question id
	images?: string[]; // file names in media/
}

export interface ModelChoice {
	model: string; // provider/id
	thinking: string;
}

export interface Settings {
	boss: ModelChoice;
	worker: ModelChoice;
	startDir: string;
	applyToRunning: boolean; // running workers follow changes of the worker default
	overrides: Record<string, ModelChoice>; // per worker
	memoryMax: string; // systemd MemoryMax for each agent's scope (pi and all it runs): "50%", "24G", or "" for none
	userName: string; // what the boss and workers call the person using the dashboard; "" = from the OS account
}

// ---------------------------------------------------------------- role across /reload

export interface Role {
	role: "boss" | "worker";
	name: string;
}
// /reload loads the extension again in the same process. The role env vars are gone by then
// (removed so child processes don't inherit them), so the role is kept on globalThis.
const ROLE_KEY = Symbol.for("perch.role");
export const rememberRole = (r: Role) => {
	(globalThis as any)[ROLE_KEY] = r;
};
export const recallRole = (): Role | undefined => (globalThis as any)[ROLE_KEY];

// ---------------------------------------------------------------- images

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MEDIA_RE = /^[a-z0-9]+\.(png|jpg|webp|gif)$/;

export function imageType(file: string): string | undefined {
	const ext = file.split(".").pop()?.toLowerCase();
	return Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === (ext === "jpeg" ? "jpg" : ext));
}

/** The line after a message's text that names its attached images, so the model can refer to or forward them. */
export const imageNote = (images?: string[]) =>
	images?.length ? `\n[${images.length === 1 ? "image" : `${images.length} images`} attached: ${images.join(", ")}]` : "";

/** Store image bytes in media/ and return the file name. */
export function saveImage(data: Uint8Array, mimeType: string): string {
	const name = `${id("i")}.${IMAGE_TYPES[mimeType] ?? "png"}`;
	mkdirSync(p.media(), { recursive: true });
	writeFileSync(p.media(name), data);
	return name;
}

/** An image file as pi image content, or undefined if it cannot be read. */
export function imageContent(path: string): { type: "image"; data: string; mimeType: string } | undefined {
	const mimeType = imageType(path);
	if (!mimeType) return;
	try {
		return { type: "image", data: readFileSync(path).toString("base64"), mimeType };
	} catch {}
}

/** An empty model or thinking level means pi's own default (no --model / --thinking). */
export const DEFAULT_SETTINGS: Settings = {
	boss: { model: "", thinking: "" },
	worker: { model: "", thinking: "" },
	startDir: "~",
	applyToRunning: false,
	overrides: {},
	memoryMax: "50%",
	userName: "",
};

/** The OS account's first name (from its full name, else the login name, capitalized). */
export function accountName(): string {
	let login = "";
	try {
		login = userInfo().username;
		const gecos = readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith(`${login}:`))?.split(":")[4] ?? "";
		const first = gecos.split(",")[0].trim().split(/\s+/)[0];
		if (first) return first;
	} catch {}
	return login ? login[0].toUpperCase() + login.slice(1) : "the user";
}

/** What agents call the user: the settings page's name, or the OS account's. */
export const userName = (s: Settings = loadSettings()) => s.userName.trim() || accountName();

export const defaultGuidance = (user = userName()) =>
	`Decide almost everything yourself and keep the workers moving. Ask ${user} when you think a call is theirs to make, ` +
	`mostly taste and direction. If ${user} is unhappy with something later, they will tell you and you iterate.`;

// ---------------------------------------------------------------- files

export const id = (prefix = "") => `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

export function writeJson(file: string, data: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
	renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function appendJsonl(file: string, data: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(data)}\n`);
}

export function readJsonl<T>(file: string, last = Infinity): T[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n").filter(Boolean);
	const out: T[] = [];
	for (const line of lines.slice(Math.max(0, lines.length - last))) {
		try {
			out.push(JSON.parse(line));
		} catch {
			/* torn write */
		}
	}
	return out;
}

export function readText(file: string, fallback = ""): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return fallback;
	}
}

export function writeText(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

export function mtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------- settings

export function loadSettings(): Settings {
	const s = readJson<Partial<Settings>>(p.settings()) ?? {};
	return {
		...DEFAULT_SETTINGS,
		...s,
		boss: { ...DEFAULT_SETTINGS.boss, ...s.boss },
		worker: { ...DEFAULT_SETTINGS.worker, ...s.worker },
		overrides: { ...s.overrides },
	};
}

export const loadGuidance = () => readText(p.guidance(), "").trim() || defaultGuidance();

export function expandHome(dir: string) {
	return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

// ---------------------------------------------------------------- inbox

/** Drop a message into an agent's inbox (atomic: write elsewhere, rename in). */
export function send(to: string, msg: Omit<Msg, "id" | "ts"> & { id?: string }): Msg {
	const full: Msg = { id: msg.id ?? id("m"), ts: Date.now(), ...msg } as Msg;
	const dir = p.inbox(to);
	mkdirSync(dir, { recursive: true });
	const tmp = join(p.agent(to), `.out-${full.id}.tmp`);
	writeFileSync(tmp, JSON.stringify(full));
	renameSync(tmp, join(dir, `${full.ts}-${full.id}.json`));
	return full;
}

/** Take every message from an agent's inbox, oldest first, logging what was taken. */
export function drain(name: string): Msg[] {
	const dir = p.inbox(name);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out: Msg[] = [];
	for (const f of files) {
		const file = join(dir, f);
		const msg = readJson<Msg>(file);
		rmSync(file, { force: true });
		if (!msg) continue;
		appendJsonl(p.inboxLog(name), msg);
		out.push(msg);
	}
	return out;
}

// ---------------------------------------------------------------- reading state

export function listAgents(): string[] {
	try {
		return readdirSync(p.agents()).filter((n) => NAME_RE.test(n) && existsSync(p.status(n))).sort();
	} catch {
		return [];
	}
}

export const readStatus = (name: string) => readJson<Status>(p.status(name));

/** A status whose process is gone without a clean shutdown reads as dead. */
export function liveStatus(name: string): Status | undefined {
	const s = readStatus(name);
	if (!s) return undefined;
	if (s.state !== "stopped" && s.state !== "dead" && !running(s)) return { ...s, state: "dead" };
	return s;
}

/** When process pid started (ms since the epoch, to about a second), from /proc. */
export function processStart(pid: number): number | undefined {
	try {
		const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]); // field 22, starttime
		return btime && Number.isFinite(ticks) ? btime * 1000 + ticks * 10 : undefined; // USER_HZ is 100 on Linux
	} catch {}
}

/**
 * The pi that wrote this status (or presence) is still running. A process with that pid must exist
 * and must have started before the file did: after a reboot the pid can belong to something else.
 */
export function running(x: { pid: number; started: number }): boolean {
	if (!alive(x.pid)) return false;
	const t = processStart(x.pid);
	return t === undefined || t <= x.started + 10_000;
}

export function alive(pid: number) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function openQuestions(): Question[] {
	let files: string[];
	try {
		files = readdirSync(p.questions()).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	return files
		.map((f) => readJson<Question>(join(p.questions(), f)))
		.filter((q): q is Question => !!q && !q.answered)
		.sort((a, b) => a.ts - b.ts);
}

export const chat = (line: Omit<ChatLine, "ts">) => appendJsonl(p.chat(), { ts: Date.now(), ...line });
