/** Overview: what needs the user, every worker at a glance, the last 12 hours, other tmux sessions. */
import { useState } from "preact/hooks";
import { Machine } from "./parts.tsx";
import { openSheet } from "./sheet.tsx";
import { api, LABEL, ORDER, type Question, type Shown, type Snapshot, type Status, shown, sortedWorkers, type Unmanaged } from "./store.ts";
import { ago, Chip, clock, color, Dot, go, Icon, money, ResumeButton, shortModel, Spark, termHref, tilde } from "./ui.tsx";

// ---------------------------------------------------------------- questions for the user

function QuestionCard({ q, compact }: { q: Question; compact?: boolean }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [typing, setTyping] = useState(!compact || !q.options?.length);
	async function answer(a: string) {
		if (!a.trim() || busy) return;
		setBusy(true);
		setErr("");
		const r = await api("/api/answer", { id: q.id, text: a.trim() });
		if (r.error) {
			setErr(r.error);
			setBusy(false);
		}
	}
	return (
		<div class={`qcard ${busy ? "busy" : ""} ${compact ? "compact" : ""}`}>
			<div class="who">
				<Dot s="needs" pulse />
				{q.worker ? (
					<button class="link" onClick={() => openSheet(q.worker!, false)}>
						{q.worker}
					</button>
				) : (
					"boss"
				)}
				<span class="faint">asks you · {ago(q.ts)} ago</span>
			</div>
			<div class="q">{q.question}</div>
			{q.context && !compact && <div class="ctx">{q.context}</div>}
			{q.options && q.options.length > 0 && (
				<div class="opts">
					{q.options.map((o, i) => (
						<button class={`btn ${i === 0 ? "primary" : ""} ${compact ? "sm" : ""}`} disabled={busy} onClick={() => answer(o)}>
							{o}
						</button>
					))}
					{!typing && (
						<button class="btn sm ghost" onClick={() => setTyping(true)}>
							Other…
						</button>
					)}
				</div>
			)}
			{typing && <form
				class="ans"
				onSubmit={(e) => {
					e.preventDefault();
					void answer(text);
				}}
			>
				<input class="txt" value={text} placeholder={q.options?.length ? "or answer in your words…" : "Your answer…"} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
				<button class={`btn ${compact ? "sm" : ""}`} disabled={!text.trim() || busy}>
					Send
				</button>
			</form>}
			{err && <div class="err">{err}</div>}
		</div>
	);
}

export function Questions({ s, compact }: { s: Snapshot; compact?: boolean }) {
	return (
		<div class="questions">
			{s.questions.map((q) => (
				<QuestionCard key={q.id} q={q} compact={compact} />
			))}
		</div>
	);
}

// ---------------------------------------------------------------- summary

function Summary({ s, W }: { s: Snapshot; W: Status[] }) {
	const counts: Partial<Record<Shown, number>> = {};
	for (const w of W) counts[shown(s, w)] = (counts[shown(s, w)] ?? 0) + 1;
	const total = W.reduce((a, w) => a + (w.milestones.length || 1), 0);
	const done = W.reduce((a, w) => a + (w.milestones.length ? Math.min(w.completed, w.milestones.length) : w.state === "done" ? 1 : 0), 0);
	return (
		<section class="summary">
			<div class="counts">
				{ORDER.filter((k) => counts[k]).map((k) => (
					<div class="count" style={{ "--c": color(k) }}>
						<b class="mono">{counts[k]}</b>
						<span>{LABEL[k]}</span>
					</div>
				))}
			</div>
			<div class="progress" title="Milestones done across all workers">
				<div class="pbar">
					{W.map((w) => {
						const n = w.milestones.length || 1;
						const d = w.milestones.length ? Math.min(w.completed, n) : w.state === "done" ? 1 : 0;
						const f = (d / n) * 100;
						return (
							<button
								title={`${w.name}: ${d}/${n}`}
								onClick={() => openSheet(w.name, false)}
								style={{ flex: n, background: `linear-gradient(90deg, ${color(shown(s, w))} ${f}%, var(--line2) ${f}%)` }}
							/>
						);
					})}
				</div>
				<div class="plabel mono">
					{done}/{total} milestones · {total ? Math.round((done / total) * 100) : 0}%
				</div>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------- worker cards

function Card({ s, w }: { s: Snapshot; w: Status }) {
	const st = shown(s, w);
	const n = w.milestones.length;
	const at = Math.min(w.completed, n);
	const live = st === "working" || st === "asking";
	return (
		<div class={`card st-${st}`} style={{ "--c": color(st) }} onClick={() => openSheet(w.name)} role="button" tabIndex={0}>
			<div class="r1">
				<span class="name">{w.name}</span>
				<Chip s={st} />
				<span class="age mono">{ago(w.updated)}</span>
				{w.tmux && w.state !== "stopped" && (
					<a class="iconbtn sm" href={termHref(w.tmux)} title="Terminal" aria-label={`${w.name} terminal`} onClick={(e) => e.stopPropagation()}>
						<Icon n="term" size={15} />
					</a>
				)}
			</div>
			<div class="headline">{w.headline || <span class="faint">no report yet</span>}</div>
			{st === "error" && w.error && <div class="errline">{w.error.slice(0, 200)}</div>}
			{w.state === "dead" && (
				<div class="deadrow">
					<div class="errline">{(w.error || "its pi is gone").slice(0, 240)}</div>
					<ResumeButton name={w.name} />
				</div>
			)}
			{n > 0 && (
				<div class="ms">
					{w.milestones.map((m, k) => (
						<i title={m} class={k < at ? "d" : k === at && live ? "a" : ""} />
					))}
				</div>
			)}
			<div class="foot">
				{n > 0 ? (
					<>
						<span class="mono">
							{at}/{n}
						</span>
						<span class="nx">{at >= n ? "all milestones done" : w.milestones[at]}</span>
					</>
				) : (
					<span class="nx" />
				)}
				<span class="mono faint">{money(w.cost || 0)}</span>
				<Spark data={w.activity} c={color(st)} />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- timeline

/** Show as much history as there is, from 1 to 12 hours, so a young fleet is not a thin sliver. */
function span(s: Snapshot, W: Status[]): number {
	let first = s.now;
	for (const w of W) for (const [a] of s.timeline[w.name] || []) first = Math.min(first, a);
	const need = (s.now - first) / 3600_000;
	const h = [1, 2, 3, 6, 12].find((x) => x >= need * 1.05) ?? 12;
	return Math.min(h * 3600_000, s.window);
}

function Timeline({ s, W }: { s: Snapshot; W: Status[] }) {
	const win = span(s, W);
	const from = s.now - win;
	const hours = win / 3600_000;
	return (
		<section class="panel">
			<h3>{hours === 1 ? "Last hour" : `Last ${hours} hours`}</h3>
			<div class="tl">
				{W.map((w) => (
					<>
						<button class="lbl" onClick={() => openSheet(w.name, false)}>
							{w.name}
						</button>
						<div class="lane">
							{(s.timeline[w.name] || []).filter(([, b]) => b > from).map(([a, b, st]) => (
								<i
									title={`${st} ${clock(a)}–${clock(b)}`}
									class={st === "idle" || st === "stopped" ? "quiet" : ""}
									style={{ left: `${(Math.max(0, a - from) / win) * 100}%`, width: `${Math.max(0.3, ((b - Math.max(a, from)) / win) * 100)}%`, background: color(st) }}
								/>
							))}
						</div>
					</>
				))}
				<span />
				<div class="axis mono">
					{[0, 0.25, 0.5, 0.75, 1].map((f) => (
						<span>{f === 1 ? "now" : clock(from + f * win)}</span>
					))}
				</div>
			</div>
			<div class="legend">
				{(["working", "asking", "needs", "idle", "done", "error"] as Shown[]).map((k) => (
					<span>
						<Dot s={k} />
						{LABEL[k]}
					</span>
				))}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------- other tmux sessions

const suggest = (n: string) =>
	n
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "worker";

function Other({ t }: { t: Unmanaged }) {
	const a = t.adoptable[0];
	const isPi = t.command === "pi" || !!a;
	const [name, setName] = useState(suggest(t.name));
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const pending = t.pending && !t.pending.error;
	async function adopt() {
		setBusy(true);
		setErr("");
		const r = await api("/api/adopt", a ? { pid: a.pid, name } : { session: t.name, name });
		setBusy(false);
		if (r.error) setErr(r.error);
		else setOpen(false);
	}
	return (
		<div class="other">
			<div class="r1">
				<span class="name">{t.name}</span>
				<span class="mono faint cmd">{t.command}</span>
				<span class="age mono">{ago(t.activity)}</span>
			</div>
			<div class="path mono">{tilde(a?.cwd || t.path)}</div>
			<div class="acts">
				<a class="btn" href={termHref(t.name)}>
					<Icon n="term" size={15} /> Terminal
				</a>
				{isPi && !open && !pending && (
					<button class="btn" onClick={() => setOpen(true)}>
						Adopt as worker…
					</button>
				)}
				{pending && <span class="faint small">reloading pi, then adopting as {t.pending!.name}…</span>}
			</div>
			{open && (
				<form
					class="adopt"
					onSubmit={(e) => {
						e.preventDefault();
						void adopt();
					}}
				>
					<label class="small faint">
						{a
							? "Worker name. Its conversation carries on; it writes its own brief and starts reporting."
							: "Worker name. perch types /reload into this pi (only if it is idle with an empty editor), then adopts it. Its conversation carries on."}
					</label>
					<div class="row">
						<input class="txt mono" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
						<button class="btn go" disabled={busy || !name}>
							{busy ? "…" : a ? "Adopt" : "Reload & adopt"}
						</button>
						<button type="button" class="btn ghost" onClick={() => setOpen(false)}>
							Cancel
						</button>
					</div>
				</form>
			)}
			{(err || t.pending?.error) && <div class="err">{err || t.pending?.error}</div>}
		</div>
	);
}

// ---------------------------------------------------------------- empty state

function Start() {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	async function send() {
		if (!text.trim()) return;
		setBusy(true);
		const r = await api("/api/chat", { text: text.trim() });
		setBusy(false);
		if (r.error) return alert(r.error);
		setText("");
		go("#/boss");
	}
	return (
		<section class="start">
			<h2>Nothing is running.</h2>
			<p>Tell the boss what should get done. It starts workers and keeps them going; you'll see them here.</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<textarea class="txt" rows={3} value={text} placeholder="e.g. Add a dark mode to ~/src/site and check it on a phone" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
				<button class="btn go" disabled={busy || !text.trim()}>
					Send to boss
				</button>
			</form>
		</section>
	);
}

// ---------------------------------------------------------------- view

export function Overview({ s, desk }: { s: Snapshot; wide: boolean; desk: boolean }) {
	const W = sortedWorkers(s);
	const live = W.filter((w) => w.state !== "stopped");
	const ended = W.filter((w) => w.state === "stopped");
	return (
		<div class="view overview">
			<header class="vh">
				<h1>Overview</h1>
				<span class="sp" />
				{!desk && (
					<a class="iconbtn" href="#/settings" aria-label="Settings">
						<Icon n="gear" />
					</a>
				)}
			</header>
			<div class="pad">
				{!desk && <Machine s={s} compact />}
				{s.questions.length > 0 && (
					<section>
						<h3 class="sh">Needs you</h3>
						<Questions s={s} />
					</section>
				)}
				{W.length > 0 ? <Summary s={s} W={live.length ? live : W} /> : <Start />}
				{live.length > 0 && (
					<section>
						<h3 class="sh">Workers</h3>
						<div class="cards">
							{live.map((w) => (
								<Card key={w.name} s={s} w={w} />
							))}
						</div>
					</section>
				)}
				{W.length > 0 && <Timeline s={s} W={W} />}
				{ended.length > 0 && (
					<section>
						<h3 class="sh">Ended</h3>
						<div class="ended">
							{ended.map((w) => (
								<button class="endrow" onClick={() => openSheet(w.name, false)}>
									<Dot s="stopped" />
									<b>{w.name}</b>
									<span class="faint">{w.headline}</span>
									<span class="mono faint">{shortModel(w.model)}</span>
								</button>
							))}
						</div>
					</section>
				)}
				{s.unmanaged.length > 0 && (
					<section>
						<h3 class="sh">Other tmux sessions</h3>
						<p class="hint">Not managed by perch. Open them, or adopt a pi session as a worker.</p>
						<div class="others">
							{s.unmanaged.map((t) => (
								<Other key={t.name} t={t} />
							))}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
