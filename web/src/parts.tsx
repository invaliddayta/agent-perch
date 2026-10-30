/** Pieces shared by the rail, the overview and the terminal: machine stats and the session list. */
import type { ComponentChildren } from "preact";
import { type Snapshot, shown, sortedWorkers } from "./store.ts";
import { ago, Dot, money, termHref } from "./ui.tsx";

/** GiB as a short number: one decimal below 10. Totals are whole numbers. */
const gb = (x: number) => (x < 9.95 ? x.toFixed(1) : String(Math.round(x)));
const total = (x: number) => String(Math.round(x));

function Stat(p: { k: string; v: ComponentChildren; pct?: number; color?: string; level?: "warn" | "crit"; title?: string }) {
	return (
		<div class={`stat ${p.level ?? ""}`} title={p.title}>
			<span class="k">{p.k}</span>
			<span class="v mono">{p.v}</span>
			{p.pct !== undefined && (
				<span class="meter">
					<i style={{ width: `${Math.min(100, p.pct)}%`, background: p.color }} />
				</span>
			)}
		</div>
	);
}

export function Machine({ s, compact }: { s: Snapshot; compact?: boolean }) {
	const g = s.gpu;
	const m = s.machine;
	const cost = [...s.workers, s.boss].reduce((a, w) => a + (w?.cost || 0), 0);
	// Memory is what kills agents (the OOM killer): warn when little is left.
	const memPct = m ? (m.mem.used / m.mem.total) * 100 : 0;
	const memLevel = memPct >= 95 ? "crit" : memPct >= 88 ? "warn" : undefined;
	const swapPct = m && m.swap.total > 0 ? (m.swap.used / m.swap.total) * 100 : 0;
	const tone = (level?: string, normal = "var(--s-working)") => (level === "crit" ? "var(--s-error)" : level === "warn" ? "var(--s-needs)" : normal);
	return (
		<div class={`machine ${compact ? "compact" : ""}`}>
			{m && <Stat k="CPU" v={`${m.cpu}%`} pct={m.cpu} color={m.cpu > 85 ? "var(--s-needs)" : "var(--s-working)"} title={`${m.cores} cores, all together`} />}
			{m && (
				<Stat
					k="RAM"
					v={
						<>
							{gb(m.mem.used)}
							<small>/{total(m.mem.total)}G</small>
						</>
					}
					pct={memPct}
					color={tone(memLevel, "var(--s-asking)")}
					level={memLevel}
					title={`${gb(m.mem.total - m.mem.used)} GiB available${memLevel ? ": the out-of-memory killer may soon stop something" : ""}`}
				/>
			)}
			{m && m.swap.total > 0 && (
				<Stat
					k="Swap"
					v={
						<>
							{gb(m.swap.used)}
							<small>/{total(m.swap.total)}G</small>
						</>
					}
					pct={swapPct}
					color={swapPct > 50 ? "var(--s-needs)" : "var(--s-idle)"}
				/>
			)}
			{g && <Stat k="GPU" v={`${g.util}%`} pct={g.util} color={g.util > 85 ? "var(--s-needs)" : "var(--s-working)"} title={g.name} />}
			{g && (
				<Stat
					k="VRAM"
					v={
						<>
							{gb(g.used / 1024)}
							<small>/{total(g.total / 1024)}G</small>
						</>
					}
					pct={(g.used / g.total) * 100}
					color="var(--s-asking)"
				/>
			)}
			<Stat k="Spend" v={money(cost)} title="What pi computes for these sessions (per-token price)" />
		</div>
	);
}

/** Every tmux session that has a terminal: boss, workers, then the rest. */
export function SessionList({ s, active, onPick }: { s: Snapshot; active?: string; onPick?: () => void }) {
	const row = (name: string, st: string, sub: string, title?: string) => (
		<a class={`srow ${active === name ? "on" : ""}`} href={termHref(name)} onClick={onPick} title={title}>
			<Dot s={st} pulse={st === "needs"} />
			<span class="nm">{name}</span>
			<span class="sub mono">{sub}</span>
		</a>
	);
	return (
		<div class="slist">
			{s.bossTmux && row("boss", s.boss?.state ?? "idle", "boss")}
			{sortedWorkers(s)
				.filter((w) => w.tmux && w.state !== "stopped")
				.map((w) => row(w.tmux!, shown(s, w), ago(w.updated), w.headline))}
			{s.unmanaged.length > 0 && <div class="sgroup">other sessions</div>}
			{s.unmanaged.map((t) => row(t.name, "stopped", t.command))}
		</div>
	);
}

