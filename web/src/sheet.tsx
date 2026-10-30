/** Worker detail: a bottom sheet on a phone, a dialog on a desktop. */
import { useEffect, useState } from "preact/hooks";
import { md } from "./md.ts";
import { api, type Snapshot, shown } from "./store.ts";
import { ago, Chip, clock, Dot, go, Icon, money, ResumeButton, shortModel, termHref } from "./ui.tsx";

let current: { name: string; tapTs: number } | null = null;
const subs = new Set<() => void>();

/** explain: ask the boss for a fresh summary (what tapping a card does). */
export async function openSheet(name: string, explain = true) {
	current = { name, tapTs: explain ? Date.now() + 1e12 : 0 };
	subs.forEach((f) => f());
	if (explain) await requestExplain(name);
}
async function requestExplain(name: string) {
	if (!current || current.name !== name) return;
	current.tapTs = Date.now() + 1e12; // waiting
	subs.forEach((f) => f());
	const r = await api<{ ts: number }>("/api/tap", { worker: name });
	if (current?.name === name) current.tapTs = r.ts ? r.ts - 1500 : 0;
	subs.forEach((f) => f());
}
export function closeSheet() {
	current = null;
	subs.forEach((f) => f());
}

export function Sheet({ s }: { s: Snapshot }) {
	const [, set] = useState(0);
	const [brief, setBrief] = useState<string | null>(null);
	const [showBrief, setShowBrief] = useState(false);
	const [tell, setTell] = useState("");
	useEffect(() => {
		const f = () => set((n) => n + 1);
		subs.add(f);
		const esc = (e: KeyboardEvent) => e.key === "Escape" && current && closeSheet();
		addEventListener("keydown", esc);
		return () => {
			subs.delete(f);
			removeEventListener("keydown", esc);
		};
	}, []);
	const name = current?.name;
	useEffect(() => {
		setBrief(null);
		setShowBrief(false);
		setTell("");
		if (name) void api<{ brief?: string }>(`/api/agent?name=${encodeURIComponent(name)}`).then((r) => setBrief(r.brief ?? ""));
	}, [name]);

	const w = name ? s.workers.find((x) => x.name === name) : undefined;
	if (!current || !w) return null;
	const st = shown(s, w);
	const n = w.milestones.length;
	const at = Math.min(w.completed, n);
	const waiting = current.tapTs > Date.now() + 1e11;
	const expl = current.tapTs ? [...s.chat].reverse().find((l) => l.from === "boss" && l.worker === w.name && l.ts >= current!.tapTs) : undefined;
	const asked = current.tapTs > 0;

	async function sendTell() {
		const v = tell.trim();
		if (!v) return;
		const r = await api("/api/chat", { text: `About ${w!.name}: ${v}` });
		if (r.error) return alert(r.error);
		closeSheet();
		go("#/boss");
	}

	return (
		<>
			<div class="scrim" onClick={closeSheet} />
			<div class="sheet" role="dialog" aria-label={w.name}>
				<div class="grab" />
				<header>
					<Dot s={st} pulse={st === "needs"} />
					<h2>{w.name}</h2>
					<Chip s={st} />
					<span class="sp" />
					<button class="iconbtn" onClick={closeSheet} aria-label="Close">
						<Icon n="x" />
					</button>
				</header>
				<div class="facts mono">
					<span>{shortModel(w.model)}</span>
					<span>{w.thinking}</span>
					<span>{money(w.cost || 0)}</span>
					{w.context !== undefined && <span>ctx {w.context}%</span>}
					<span>up {ago(w.started)}</span>
					<span>updated {ago(w.updated)} ago</span>
				</div>
				<p class="headline">{w.headline}</p>
				{(st === "error" || w.state === "dead") && w.error && <div class="errline">{w.error}</div>}

				<div class="bosssays">
					<div class="lbl">
						<Icon n="sparkle" size={13} /> boss
						{expl ? ` · ${clock(expl.ts)}` : ""}
					</div>
					{expl ? (
						<div class="md" dangerouslySetInnerHTML={{ __html: md(expl.text) }} />
					) : asked || waiting ? (
						<div class="faint">
							<span class="dots">
								<i />
								<i />
								<i />
							</span>{" "}
							looking at {w.name}…
						</div>
					) : (
						<button class="btn" onClick={() => requestExplain(w.name)}>
							Ask the boss how it is going
						</button>
					)}
				</div>

				{n > 0 && (
					<ol class="mlist">
						{w.milestones.map((m, k) => (
							<li class={k < at ? "d" : k === at ? "a" : ""}>
								<span class="mk">{k < at ? "✓" : k === at ? "▸" : ""}</span>
								{m}
							</li>
						))}
					</ol>
				)}

				{brief && (
					<div class="brief">
						<button class="link" onClick={() => setShowBrief(!showBrief)}>
							{showBrief ? "Hide brief" : "Show brief"}
						</button>
						{showBrief && <div class="md" dangerouslySetInnerHTML={{ __html: md(brief) }} />}
					</div>
				)}

				<form
					class="tell"
					onSubmit={(e) => {
						e.preventDefault();
						void sendTell();
					}}
				>
					<input class="txt" value={tell} placeholder={`Tell the boss what ${w.name} should do…`} onInput={(e) => setTell((e.target as HTMLInputElement).value)} />
					<button class="btn" disabled={!tell.trim()}>
						Send
					</button>
				</form>
				<div class="acts">
					{(w.state === "dead" || w.state === "stopped") && <ResumeButton name={w.name} />}
					{w.tmux && w.state !== "stopped" && w.state !== "dead" && (
						<a class="btn" href={termHref(w.tmux)} onClick={closeSheet}>
							<Icon n="term" size={15} /> Open terminal
						</a>
					)}
				</div>
			</div>
		</>
	);
}
