/** Small shared pieces: routing, time formats, icons, state dots and chips. */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, LABEL, now, type Shown } from "./store.ts";

// ---------------------------------------------------------------- routing (#/, #/boss, #/t/<name>, #/settings)

export type Route = { view: "overview" } | { view: "boss" } | { view: "term"; name?: string } | { view: "settings" };

export function parseRoute(hash = location.hash): Route {
	const h = hash.replace(/^#\/?/, "");
	if (h === "boss") return { view: "boss" };
	if (h === "settings") return { view: "settings" };
	if (h === "t" || h === "t/") return { view: "term" };
	if (h.startsWith("t/")) return { view: "term", name: decodeURIComponent(h.slice(2)) };
	if (h === "overview") return { view: "overview" };
	return { view: (localStorage.getItem("np-home") as "boss" | "overview") || "boss" } as Route;
}

export const go = (to: string) => {
	if (location.hash !== to) location.hash = to;
};
export const termHref = (name: string) => `#/t/${encodeURIComponent(name)}`;

export function useRoute(): Route {
	const [r, set] = useState(parseRoute());
	useEffect(() => {
		const f = () => set(parseRoute());
		addEventListener("hashchange", f);
		return () => removeEventListener("hashchange", f);
	}, []);
	return r;
}

export function useMedia(q: string) {
	const [m, set] = useState(() => matchMedia(q).matches);
	useEffect(() => {
		const mq = matchMedia(q);
		const f = () => set(mq.matches);
		mq.addEventListener("change", f);
		return () => mq.removeEventListener("change", f);
	}, [q]);
	return m;
}

// ---------------------------------------------------------------- formats

export function ago(ts: number) {
	const s = Math.max(0, Math.round((now() - ts) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
export const shortModel = (m?: string) => (m || "").split("/").pop() || "";
export const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

// ---------------------------------------------------------------- state color

export const color = (s: Shown | string) => `var(--s-${s in LABEL ? s : "idle"})`;

export function Dot({ s, pulse }: { s: Shown | string; pulse?: boolean }) {
	return <span class={`dot ${pulse ? "pulse" : ""}`} style={{ "--c": color(s) }} />;
}
export function Chip({ s }: { s: Shown }) {
	return (
		<span class={`chip ${s === "needs" ? "pulse" : ""}`} style={{ "--c": color(s) }}>
			{LABEL[s]}
		</span>
	);
}

// ---------------------------------------------------------------- icons (lucide paths, MIT)

const P: Record<string, ComponentChildren> = {
	chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
	grid: (
		<>
			<rect x="3" y="3" width="7" height="9" rx="1.5" />
			<rect x="14" y="3" width="7" height="5" rx="1.5" />
			<rect x="14" y="12" width="7" height="9" rx="1.5" />
			<rect x="3" y="16" width="7" height="5" rx="1.5" />
		</>
	),
	term: (
		<>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</>
	),
	gear: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
		</>
	),
	send: (
		<>
			<path d="m22 2-7 20-4-9-9-4z" />
			<path d="M22 2 11 13" />
		</>
	),
	mic: (
		<>
			<rect x="9" y="2" width="6" height="12" rx="3" />
			<path d="M19 10v1a7 7 0 0 1-14 0v-1" />
			<line x1="12" y1="18" x2="12" y2="22" />
		</>
	),
	stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
	image: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
		</>
	),
	x: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),
	back: <path d="m15 18-6-6 6-6" />,
	right: <path d="m9 18 6-6-6-6" />,
	up: <path d="m18 15-6-6-6 6" />,
	down: <path d="m6 9 6 6 6-6" />,
	plus: (
		<>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</>
	),
	minus: <path d="M5 12h14" />,
	copy: (
		<>
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</>
	),
	enter: (
		<>
			<polyline points="9 10 4 15 9 20" />
			<path d="M20 4v7a4 4 0 0 1-4 4H4" />
		</>
	),
	keyboard: (
		<>
			<rect x="2" y="6" width="20" height="12" rx="2" />
			<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
		</>
	),
	history: (
		<>
			<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
			<path d="M3 3v5h5" />
			<path d="M12 7v5l4 2" />
		</>
	),
	fit: (
		<>
			<path d="M15 3h6v6" />
			<path d="M9 21H3v-6" />
			<path d="M21 3l-7 7" />
			<path d="M3 21l7-7" />
		</>
	),
	refresh: (
		<>
			<path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
			<path d="M21 3v5h-5" />
		</>
	),
	external: (
		<>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</>
	),
	type: (
		<>
			<polyline points="4 7 4 4 20 4 20 7" />
			<line x1="9" y1="20" x2="15" y2="20" />
			<line x1="12" y1="4" x2="12" y2="20" />
		</>
	),
	paste: (
		<>
			<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
			<rect x="8" y="2" width="8" height="4" rx="1" />
		</>
	),
	sparkle: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />,
};

export function Icon({ n, size = 18, ...rest }: { n: keyof typeof P | string; size?: number } & JSX.SVGAttributes<SVGSVGElement>) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			{...rest}
		>
			{P[n]}
		</svg>
	);
}

// ---------------------------------------------------------------- copy (works without HTTPS too)

export async function copyText(text: string): Promise<boolean> {
	try {
		if (window.isSecureContext && navigator.clipboard) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
	document.body.appendChild(ta);
	ta.select();
	ta.setSelectionRange(0, text.length);
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {}
	ta.remove();
	return ok;
}

export function Spark({ data, c, w = 64, h = 18 }: { data: number[]; c: string; w?: number; h?: number }) {
	if (!data?.length) return null;
	const m = Math.max(...data, 1);
	const pts = data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - 1 - (v / m) * (h - 3)).toFixed(1)}`).join(" ");
	return (
		<svg class="spark" width={w} height={h} aria-hidden="true">
			<polyline points={pts} fill="none" stroke={c} stroke-width="1.5" stroke-linejoin="round" />
		</svg>
	);
}

/** Start a dead agent again: runs its run.sh, which continues its conversation. */
export function ResumeButton({ name }: { name: string }) {
	const [busy, setBusy] = useState(false);
	return (
		<button
			class="btn go sm"
			disabled={busy}
			onClick={async (e) => {
				e.stopPropagation();
				setBusy(true);
				const r = await api("/api/resume", { name });
				if (r.error) {
					alert(r.error);
					setBusy(false);
				} else setTimeout(() => setBusy(false), 10_000);
			}}
		>
			{busy ? "starting…" : "Resume"}
		</button>
	);
}

