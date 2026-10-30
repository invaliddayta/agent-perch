/** perch dashboard: app shell, navigation and layout. */
import "./style.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Chat, unreadCount } from "./chat.tsx";
import { Lightbox } from "./images.tsx";
import { Overview } from "./overview.tsx";
import { Settings } from "./settings.tsx";
import { Sheet } from "./sheet.tsx";
import { Machine, SessionList } from "./parts.tsx";
import { isOnline, type Snapshot, useSnap } from "./store.ts";
import { TermView } from "./terminal.tsx";
import { go, Icon, termHref, useMedia, useRoute } from "./ui.tsx";

/** Visible height without the soft keyboard (iOS ignores interactive-widget). */
function trackViewport() {
	const vv = window.visualViewport;
	const set = () => {
		document.documentElement.style.setProperty("--vh", `${vv ? vv.height : innerHeight}px`);
		document.documentElement.classList.toggle("kb", !!vv && innerHeight - vv.height > 120);
	};
	set();
	vv?.addEventListener("resize", set);
	vv?.addEventListener("scroll", () => scrollTo(0, 0));
}
trackViewport();

function Rail({ s, view, term, wide }: { s: Snapshot; view: string; term?: string; wide: boolean }) {
	const needs = s.questions.length;
	return (
		<nav class="rail">
			<a class="logo" href="#/overview">
				perch<b>.</b>
			</a>
			<a class={`nav ${view === "overview" || (wide && view === "boss") ? "on" : ""}`} href="#/overview">
				<Icon n="grid" />
				Overview
				{needs > 0 && <span class="badge needs">{needs}</span>}
			</a>
			{!wide && (
				<a class={`nav ${view === "boss" ? "on" : ""}`} href="#/boss">
					<Icon n="chat" />
					Boss
					{unreadCount() > 0 && <span class="badge">{unreadCount()}</span>}
				</a>
			)}
			<a class={`nav ${view === "settings" ? "on" : ""}`} href="#/settings">
				<Icon n="gear" />
				Settings
			</a>
			<div class="rail-h">Terminals</div>
			<SessionList s={s} active={view === "term" ? term : undefined} />
			<div class="rail-foot">
				<Machine s={s} />
			</div>
		</nav>
	);
}

function Tabs({ s, view, term }: { s: Snapshot; view: string; term?: string }) {
	const needs = s.questions.length;
	const unread = unreadCount();
	const tab = (to: string, v: string, icon: string, label: string, badge?: preact.ComponentChildren) => (
		<a class={`tab ${view === v ? "on" : ""}`} href={to}>
			<span class="ti">
				<Icon n={icon} size={22} />
				{badge}
			</span>
			<span>{label}</span>
		</a>
	);
	return (
		<nav class="tabs">
			{tab("#/boss", "boss", "chat", "Boss", unread > 0 && view !== "boss" ? <span class="badge">{unread}</span> : null)}
			{tab("#/overview", "overview", "grid", "Overview", needs > 0 ? <span class="badge needs">{needs}</span> : null)}
			{tab(term ? termHref(term) : "#/t", "term", "term", "Terminal")}
		</nav>
	);
}

function TermPicker({ s }: { s: Snapshot }) {
	return (
		<div class="view picker">
			<header class="vh">
				<h1>Terminals</h1>
				<a class="iconbtn" href="#/settings" aria-label="Settings">
					<Icon n="gear" />
				</a>
			</header>
			<div class="pad">
				<p class="hint">Open any tmux session. Your laptop's view of it keeps its size.</p>
				<SessionList s={s} />
			</div>
		</div>
	);
}

function App() {
	const s = useSnap();
	const r = useRoute();
	const desk = useMedia("(min-width: 900px)");
	const wide = useMedia("(min-width: 1200px)");
	const [lastTerm, setLastTerm] = useState<string | undefined>(() => localStorage.getItem("np-term") || undefined);

	useEffect(() => {
		if (r.view === "term" && r.name) {
			setLastTerm(r.name);
			localStorage.setItem("np-term", r.name);
		}
		if (r.view === "boss" || r.view === "overview") localStorage.setItem("np-home", r.view);
	}, [r]);
	useEffect(() => {
		document.title = s?.questions.length ? `(${s.questions.length}) perch` : "perch";
	}, [s?.questions.length]);

	if (!s)
		return (
			<div class="boot">
				perch<b>.</b>
				<small>{isOnline() ? "loading" : "connecting…"}</small>
			</div>
		);

	// The last opened terminal stays connected (hidden) while other views show.
	const termName = r.view === "term" && r.name ? r.name : lastTerm;
	const termExists = (n?: string) => !!n && (n === "boss" ? s.bossTmux : s.workers.some((w) => w.tmux === n) || s.unmanaged.some((t) => t.name === n));
	const keep = termName && termExists(termName) ? termName : undefined;

	let main: preact.ComponentChildren;
	if (r.view === "settings") main = <Settings s={s} />;
	else if (r.view === "term" && !r.name) main = <TermPicker s={s} />;
	else if (r.view === "term" && r.name && !termExists(r.name))
		main = (
			<div class="view">
				<div class="pad empty-state">
					<h2>No session “{r.name}”</h2>
					<p>It has ended or was renamed.</p>
					<a class="btn" href="#/t">
						Pick another
					</a>
				</div>
			</div>
		);
	else if (r.view === "boss" && !wide) main = <Chat s={s} />;
	else if (r.view === "term") main = null;
	else main = <Overview s={s} wide={wide} desk={desk} />;

	return (
		<div class={`app ${desk ? "desk" : "phone"} ${wide ? "wide" : ""} ${!isOnline() ? "offline" : ""}`}>
			{desk && <Rail s={s} view={r.view} term={r.view === "term" ? r.name : undefined} wide={wide} />}
			<main class="main">
				{main}
				{keep && <TermView key={keep} name={keep} active={r.view === "term" && r.name === keep} s={s} desk={desk} />}
			</main>
			{wide && (
				<aside class="dock">
					<Chat s={s} docked questions={r.view !== "overview" && r.view !== "boss"} />
				</aside>
			)}
			{!desk && <Tabs s={s} view={r.view} term={keep} />}
			<Sheet s={s} />
			<Lightbox />
			{!isOnline() && <div class="offline-bar">reconnecting to {s?.host ?? "the server"}…</div>}
		</div>
	);
}

render(<App />, document.getElementById("app")!);

// The service worker (web/src/sw.js): an offline page instead of the browser's error page.
navigator.serviceWorker?.register("/sw.js").catch(() => {});

// Old links (#settings) still work.
if (location.hash === "#settings") go("#/settings");
