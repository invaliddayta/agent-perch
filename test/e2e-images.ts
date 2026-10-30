#!/usr/bin/env bun
/**
 * Images and questions, end to end with a real (cheap) model: the user sends an image through the
 * dashboard API, the boss sees it, forwards it to a worker with tell, and the worker sees it too.
 * Then the boss asks the user something, the user answers in the chat, and the boss closes the question.
 * Throwaway PERCH_HOME, tmux -L perch-e2e, port 4328.
 *   bun test/e2e-images.ts [provider/model]
 */
import { MODEL as model } from "./common.ts";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = `/tmp/perch-e2e/img-${Date.now()}`;
process.env.PERCH_HOME = join(root, "home");
const PORT = 4328;
const base = `http://127.0.0.1:${PORT}`;

const { launch } = await import("../ext/launch.ts");
const store = await import("../ext/store.ts");
const { tmux } = await import("../ext/tmux.ts");
const { p } = store;

/** A solid-color PNG. */
function png(w: number, h: number, [r, g, b]: number[]): Buffer {
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const cleanup = () => Bun.spawnSync(["tmux", "-L", "perch-e2e", "kill-server"]);
let server: ReturnType<typeof spawn> | undefined;
const fail = (msg: string) => {
	console.error(`FAIL: ${msg}`);
	for (const s of ["boss", "eye"]) console.error(`--- ${s}\n${tmux("capture-pane", "-p", "-t", s).out.slice(-2500)}`);
	console.error(`--- chat\n${JSON.stringify(store.readJsonl(p.chat()), null, 1)}`);
	server?.kill();
	cleanup();
	process.exit(1);
};
async function until<T>(what: string, fn: () => T | undefined | false, secs = 240): Promise<T> {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await Bun.sleep(1000);
	}
	return fail(`timed out waiting for ${what}`) as never;
}
const chat = () => store.readJsonl<store.ChatLine>(p.chat());
const post = (path: string, data: unknown) =>
	fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());
const bossReplyAfter = (n: number) => until("boss reply", () => chat().slice(n).find((l) => l.from === "boss"));

mkdirSync(store.home(), { recursive: true });
const choice = { model, thinking: "off" };
store.writeJson(p.settings(), { ...store.DEFAULT_SETTINGS, boss: choice, worker: choice });
console.log(`home ${store.home()}, model ${model}`);

try {
	server = spawn("bun", ["bin/perch.ts", "web"], {
		cwd: `${import.meta.dir}/..`,
		env: { ...process.env, PERCH_PORT: String(PORT), PERCH_HOST: "127.0.0.1", PERCH_TLS: "off" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	const r = launch({ name: "boss", role: "boss", choice, startDir: "~" });
	if (!r.ok) fail(r.error ?? "launch boss");
	await until("boss up", () => store.liveStatus("boss")?.pid);
	for (let i = 0; i < 100 && !(await fetch(`${base}/api/state`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
	console.log("✓ boss and web up");

	// 1. The user sends an image; the boss must see it (the text alone does not say the color).
	let n = chat().length;
	const img = png(96, 96, [0, 170, 0]).toString("base64");
	const sent = await post("/api/chat", { text: "What color is this picture? One word.", images: [{ mimeType: "image/png", data: img }] });
	if (!sent.ok) fail(`POST /api/chat: ${JSON.stringify(sent)}`);
	const line = chat().slice(n).find((l) => l.from === "user");
	if (!line?.images?.length) fail("chat line has no images");
	const media = await fetch(`${base}/media/${line!.images![0]}`);
	if (!media.ok || media.headers.get("content-type") !== "image/png") fail("image not served from /media/");
	console.log(`✓ image stored and served: /media/${line!.images![0]}`);
	const reply = await bossReplyAfter(n);
	console.log(`✓ boss: ${reply.text}`);
	if (!/green/i.test(reply.text)) fail("the boss did not see the image");

	// 2. The boss forwards it to a worker with tell.
	n = chat().length;
	await post("/api/chat", {
		text:
			`Start a worker named eye with this brief, word for word: "Wait for a message from the boss and do what it says. Use only the report tool." ` +
			`Then use tell to send eye the image I sent before, with the message: "Report the main color of this image as your headline, with finished true." Confirm in one line.`,
	});
	await until("told eye with the image", () => chat().slice(n).find((l) => l.from === "act" && /told eye/.test(l.text) && l.images?.length));
	console.log(`✓ ${chat().slice(n).find((l) => l.from === "act" && /told eye/.test(l.text))?.text}`);
	const eye = await until("eye done", () => {
		const s = store.liveStatus("eye");
		return s?.state === "done" && s;
	});
	console.log(`✓ eye: "${eye.headline}"`);
	if (!/green/i.test(eye.headline)) fail("the worker did not see the image");

	// 3. A question answered in the chat gets closed.
	n = chat().length;
	await post("/api/chat", { text: "Test: use ask_user to ask me 'Tabs or spaces?' with the options tabs and spaces. Then end your turn without saying more." });
	const q = await until("open question", () => store.openQuestions()[0]);
	console.log(`✓ asked: ${q.question}`);
	await until("boss idle", () => store.liveStatus("boss")?.state === "idle", 120);
	const t0 = Date.now();
	await post("/api/chat", { text: "Spaces." });
	await until("question closed", () => !store.openQuestions().length);
	const closed = store.readJson<store.Question>(p.question(q.id))!;
	console.log(`✓ closed after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${closed.answered?.how} · ${closed.answered?.text}`);
	if (closed.answered?.how !== "chat") fail("expected how=chat");
	const st = await (await fetch(`${base}/api/state`)).json();
	if (st.questions.length) fail("dashboard still shows the question");
	console.log("✓ dashboard has no open questions");
} catch (e) {
	fail(String(e));
}
server?.kill();
store.send("boss", { from: "web", kind: "end", text: "" });
cleanup();
console.log("PASS");
