/** The boss chat: the user's main way in. Full height on a phone, docked on the right on a desktop. */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { imageFiles, type Pending, prepare, Thumbs } from "./images.tsx";
import { md } from "./md.ts";
import { Questions } from "./overview.tsx";
import { openSheet } from "./sheet.tsx";
import { api, bossRunning, type ChatLine, now, type Snapshot, shown, sortedWorkers } from "./store.ts";
import { clock, Dot, Icon, shortModel, termHref } from "./ui.tsx";
import { VoiceButton } from "./voicebtn.tsx";

// ---------------------------------------------------------------- unread (boss lines the user has not seen)

let seen = Number(localStorage.getItem("np-seen") || 0);
let lastBoss = 0;
export const unreadCount = () => unread;
let unread = 0;
function markSeen() {
	if (lastBoss > seen) {
		seen = lastBoss;
		localStorage.setItem("np-seen", String(seen));
	}
	unread = 0;
}
export function countUnread(lines: ChatLine[], visible: boolean) {
	const boss = lines.filter((l) => l.from === "boss");
	lastBoss = boss.length ? boss[boss.length - 1].ts : 0;
	if (visible && !document.hidden) markSeen();
	unread = boss.filter((l) => l.ts > seen).length;
}

// ---------------------------------------------------------------- messages

function Line({ l, prev, open }: { l: ChatLine; prev?: ChatLine; open: Set<string> }) {
	const gap = !prev || l.ts - prev.ts > 10 * 60_000 || prev.from !== l.from;
	if (l.from === "act")
		return (
			<div class="act">
				<span class="mono t">{clock(l.ts)}</span>
				<span>
					{l.text}
					<Thumbs names={l.images} small />
				</span>
			</div>
		);
	if (l.from === "user")
		return (
			<div class={`msg user ${gap ? "gap" : ""}`}>
				<Thumbs names={l.images} />
				{l.text && <div class="bubble">{l.text}</div>}
				<div class="meta">
					{clock(l.ts)}
					{l.via === "terminal" ? " · typed in the boss terminal" : ""}
					{l.ref ? " · answer" : ""}
				</div>
			</div>
		);
	const closed = !!l.ref && !open.has(l.ref);
	return (
		<div class={`msg boss ${gap ? "gap" : ""} ${l.ref ? "ask" : ""} ${closed ? "closed" : ""}`}>
			{(l.worker || l.ref) && (
				<div class="about">
					{l.ref ? (closed ? "question for you · closed" : "question for you") : ""}
					{l.ref && l.worker ? " · " : ""}
					{l.worker && <button onClick={() => openSheet(l.worker!, false)}>{l.worker}</button>}
				</div>
			)}
			<Thumbs names={l.images} />
			<div class="bubble md" dangerouslySetInnerHTML={{ __html: md(l.text) }} />
			<div class="meta">{clock(l.ts)}</div>
		</div>
	);
}

function Thinking({ since }: { since: number }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, Math.round((now() - since) / 1000));
	return (
		<div class="thinking">
			<span class="dots">
				<i />
				<i />
				<i />
			</span>
			boss is working{s > 2 ? ` · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}` : ""}
		</div>
	);
}

function WorkerStrip({ s }: { s: Snapshot }) {
	const W = sortedWorkers(s).filter((w) => w.state !== "stopped");
	if (!W.length) return null;
	return (
		<div class="wstrip">
			{W.map((w) => {
				const st = shown(s, w);
				const n = w.milestones.length;
				return (
					<button class="wchip" style={{ "--c": `var(--s-${st})` }} onClick={() => openSheet(w.name)}>
						<Dot s={st} pulse={st === "needs"} />
						<span>{w.name}</span>
						{n > 0 && (
							<span class="mono n">
								{Math.min(w.completed, n)}/{n}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------- composer

/** Files dropped anywhere on the chat go to the composer. */
let dropSink: ((f: File[]) => void) | undefined;

function Composer({ disabled }: { disabled?: boolean }) {
	const [text, setText] = useState(() => sessionStorage.getItem("np-draft") || "");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [imgs, setImgs] = useState<Pending[]>([]);
	const [reading, setReading] = useState(0);
	const ta = useRef<HTMLTextAreaElement>(null);
	const pick = useRef<HTMLInputElement>(null);
	const touch = matchMedia("(pointer: coarse)").matches;

	async function add(files: File[]) {
		if (!files.length) return;
		setErr("");
		setReading((n) => n + files.length);
		for (const f of files) {
			try {
				const im = await prepare(f);
				setImgs((old) => (old.length >= 8 ? old : [...old, im]));
			} catch (e) {
				setErr(e instanceof Error ? e.message : String(e));
			} finally {
				setReading((n) => n - 1);
			}
		}
	}
	dropSink = add;
	const drop = (i: number) =>
		setImgs((old) => {
			URL.revokeObjectURL(old[i].url);
			return old.filter((_, j) => j !== i);
		});

	useLayoutEffect(() => {
		const el = ta.current!;
		el.style.height = "0px";
		el.style.height = `${Math.min(180, el.scrollHeight)}px`;
		sessionStorage.setItem("np-draft", text);
	}, [text]);

	const ready = (text.trim() || imgs.length) && !busy && !reading;
	async function send() {
		const t = text.trim();
		if (!ready) return;
		setBusy(true);
		setErr("");
		const r = await api("/api/chat", { text: t, images: imgs.map(({ mimeType, data }) => ({ mimeType, data })) });
		setBusy(false);
		if (r.error) return setErr(r.error);
		setText("");
		for (const im of imgs) URL.revokeObjectURL(im.url);
		setImgs([]);
		if (!touch) ta.current?.focus();
	}

	return (
		<form
			class="composer"
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			{err && <div class="err">{err}</div>}
			{(imgs.length > 0 || reading > 0) && (
				<div class="pending">
					{imgs.map((im, i) => (
						<span class="pimg">
							<img src={im.url} alt="" />
							<button type="button" aria-label="Remove image" onClick={() => drop(i)}>
								<Icon n="x" size={12} />
							</button>
						</span>
					))}
					{reading > 0 && (
						<span class="pimg wait">
							<span class="spin" />
						</span>
					)}
				</div>
			)}
			<div class="row">
				<input
					ref={pick}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={(e) => {
						const el = e.currentTarget;
						void add(imageFiles(el.files));
						el.value = "";
					}}
				/>
				<button type="button" class="attbtn" aria-label="Add images" title="Add images (or paste / drop them)" onClick={() => pick.current?.click()}>
					<Icon n="image" size={19} />
				</button>
				<textarea
					ref={ta}
					rows={1}
					value={text}
					placeholder={disabled ? "boss is not running" : "Message the boss"}
					enterkeyhint={touch ? "enter" : "send"}
					onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
					onPaste={(e) => {
						const files = imageFiles(e.clipboardData?.items);
						if (!files.length) return;
						e.preventDefault();
						void add(files);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<VoiceButton onText={(t) => setText((old) => (old.trim() ? `${old.trimEnd()} ${t}` : t))} />
				<button class="sendbtn" disabled={!ready} aria-label="Send">
					{busy ? <span class="spin" /> : <Icon n="send" size={18} />}
				</button>
			</div>
		</form>
	);
}

// ---------------------------------------------------------------- view

export function Chat({ s, docked, questions = true }: { s: Snapshot; docked?: boolean; questions?: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const running = bossRunning(s);
	const b = s.boss;
	const lines = s.chat;
	const open = new Set(s.questions.map((q) => q.id));
	const [dragging, setDragging] = useState(false);
	countUnread(lines, true);

	useLayoutEffect(() => {
		const el = box.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		// The composer grows (text, image previews): stay at the bottom if we were there.
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			if (stick.current) el.scrollTop = el.scrollHeight;
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	useEffect(() => {
		const f = () => !document.hidden && markSeen();
		document.addEventListener("visibilitychange", f);
		return () => document.removeEventListener("visibilitychange", f);
	}, []);

	const [starting, setStarting] = useState(false);
	async function start() {
		setStarting(true);
		const r = await api("/api/boss/start", {});
		if (r.error) alert(r.error);
		setTimeout(() => setStarting(false), 8000);
	}

	return (
		<div
			class={`view chat ${docked ? "docked" : ""} ${dragging ? "dragging" : ""}`}
			onDragOver={(e) => {
				if (!e.dataTransfer?.types.includes("Files")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
			}}
			onDrop={(e) => {
				setDragging(false);
				const files = imageFiles(e.dataTransfer?.files);
				if (!files.length) return;
				e.preventDefault();
				void dropSink?.(files);
			}}
		>
			<header class="vh">
				<Dot s={running ? b!.state : "stopped"} />
				<h1>Boss</h1>
				<span class="sub mono">{running ? `${shortModel(b!.model)} · ${b!.thinking}` : "not running"}</span>
				<span class="sp" />
				{s.bossTmux && (
					<a class="iconbtn" href={termHref("boss")} title="Boss terminal" aria-label="Boss terminal">
						<Icon n="term" />
					</a>
				)}
				{!docked && (
					<a class="iconbtn" href="#/settings" aria-label="Settings">
						<Icon n="gear" />
					</a>
				)}
			</header>
			{!docked && <WorkerStrip s={s} />}
			<div
				class="msgs"
				ref={box}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{lines.length === 0 && (
					<div class="hello">
						<h2>Tell the boss what you want done.</h2>
						<p>It starts workers, answers their questions and only comes to you for the calls that are yours. Their progress shows on the overview.</p>
					</div>
				)}
				{lines.map((l, i) => (
					<Line key={`${l.ts}-${i}`} l={l} prev={lines[i - 1]} open={open} />
				))}
				{running && b!.state === "working" && <Thinking since={b!.updated} />}
				{!running && (
					<div class="notice">
						The boss is not running.
						<button class="btn go" disabled={starting} onClick={start}>
							{starting ? "starting…" : "Start boss"}
						</button>
					</div>
				)}
			</div>
			{questions && s.questions.length > 0 && (
				<div class="pinned">
					<Questions s={s} compact />
				</div>
			)}
			<Composer disabled={!running} />
		</div>
	);
}
