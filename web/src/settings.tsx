/** Settings: your name, models for boss and workers, the boss's guidance, and this device's preferences. */
import { useEffect, useState } from "preact/hooks";
import { api, type Snapshot, shown } from "./store.ts";
import { Dot, Icon, shortModel } from "./ui.tsx";
import { secureHere, voiceInfo } from "./voicebtn.tsx";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Phone labels, so all eight fit on one line. */
const SHORT: Record<string, string> = { minimal: "min", medium: "med" };
interface Model {
	id: string;
	provider: string;
	name: string;
	reasoning?: boolean;
	thinking?: string[];
}
interface Choice {
	model: string;
	thinking: string;
}
interface SettingsData {
	boss: Choice;
	worker: Choice;
	startDir: string;
	applyToRunning: boolean;
	overrides: Record<string, Choice>;
	memoryMax: string;
	userName: string;
}
interface Loaded {
	settings: SettingsData;
	guidance: string;
	defaultGuidance: string;
	accountName: string;
	models: Model[];
}

function ModelSelect({ models, value, onChange }: { models: Model[]; value: string; onChange: (v: string) => void }) {
	const by: Record<string, Model[]> = {};
	for (const m of models) (by[m.provider] ||= []).push(m);
	const known = models.some((m) => m.id === value);
	return (
		<select class="txt" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
			<option value="">pi's default</option>
			{!known && value && <option value={value}>{value} (not available)</option>}
			{Object.entries(by).map(([p, ms]) => (
				<optgroup label={p}>
					{ms.map((m) => (
						<option value={m.id}>{m.id.split("/").slice(1).join("/")}</option>
					))}
				</optgroup>
			))}
		</select>
	);
}

function Levels({ models, c, onChange }: { models: Model[]; c: Choice; onChange: (l: string) => void }) {
	const ok = models.find((m) => m.id === c.model)?.thinking ?? LEVELS;
	return (
		<div class="seg" role="radiogroup">
			{["", ...LEVELS.filter((l) => ok.includes(l))].map((l) => (
				<button type="button" role="radio" aria-checked={c.thinking === l} class={c.thinking === l ? "on" : ""} onClick={() => onChange(l)} title={l ? l : "pi's default"}>
					{SHORT[l] ? (
						<>
							<span class="full">{l}</span>
							<span class="short">{SHORT[l]}</span>
						</>
					) : (
						l || "auto"
					)}
				</button>
			))}
		</div>
	);
}

/** Pick a model; keep the thinking level if the new model has it, else its highest. */
function withModel(models: Model[], c: Choice, model: string): Choice {
	const ok = models.find((m) => m.id === model)?.thinking ?? LEVELS;
	return { model, thinking: !c.thinking || ok.includes(c.thinking) ? c.thinking : ok[ok.length - 1] };
}

export function Settings({ s }: { s: Snapshot }) {
	const [data, setData] = useState<Loaded | null>(null);
	const [draft, setDraft] = useState<SettingsData | null>(null);
	const [guidance, setGuidance] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);
	const [font, setFont] = useState(() => localStorage.getItem("np-font-phone") || "12");
	const [home, setHome] = useState(() => localStorage.getItem("np-home") || "boss");

	async function load() {
		const r = await api<Loaded>("/api/settings");
		if (r.error) return setMsg(r.error);
		setData(r);
		setDraft(structuredClone(r.settings));
		setGuidance(r.guidance);
	}
	useEffect(() => {
		void load();
	}, []);

	if (!data || !draft)
		return (
			<div class="view settings">
				<header class="vh">
					<h1>Settings</h1>
				</header>
				<div class="pad faint">{msg || "loading models from pi…"}</div>
			</div>
		);

	const models = data.models;
	const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings) || guidance.trim() !== data.guidance.trim();
	const set = (f: (d: SettingsData) => void) => {
		const d = structuredClone(draft);
		f(d);
		setDraft(d);
		setMsg("");
	};
	const workers = s.workers.filter((w) => w.state !== "stopped");
	const provs: Record<string, number> = {};
	for (const m of models) provs[m.provider] = (provs[m.provider] || 0) + 1;

	async function save() {
		setSaving(true);
		const r = await api("/api/settings", { settings: draft, guidance });
		setSaving(false);
		if (r.error) return setMsg(r.error);
		setMsg("Saved. Each agent picks it up at its next turn.");
		await load();
	}

	return (
		<div class="view settings">
			<header class="vh">
				<h1>Settings</h1>
			</header>
			<div class="pad narrow">
				<section class="set">
					<h2>You</h2>
					<div class="fld">
						<label>Name</label>
						<input
							class="txt"
							value={draft.userName}
							placeholder={data.accountName}
							maxLength={40}
							onInput={(e) => set((d) => (d.userName = (e.target as HTMLInputElement).value))}
						/>
					</div>
					<p class="hint tight">What the boss and the workers call you. Empty: {data.accountName}, from your account.</p>
				</section>

				<section class="set">
					<h2>
						<Dot s="working" /> Boss
					</h2>
					<p class="hint">The one you talk to. Changes apply at its next turn; no restart.</p>
					<div class="fld">
						<label>Model</label>
						<ModelSelect models={models} value={draft.boss.model} onChange={(v) => set((d) => (d.boss = withModel(models, d.boss, v)))} />
					</div>
					<div class="fld">
						<label>Thinking</label>
						<Levels models={models} c={draft.boss} onChange={(l) => set((d) => (d.boss.thinking = l))} />
					</div>
					{s.boss && (
						<p class="now mono">
							running now: {shortModel(s.boss.model)} · {s.boss.thinking || "auto"}
						</p>
					)}
				</section>

				<section class="set">
					<h2>
						<Dot s="asking" /> Workers
					</h2>
					<p class="hint">The default for new workers.</p>
					<div class="fld">
						<label>Model</label>
						<ModelSelect models={models} value={draft.worker.model} onChange={(v) => set((d) => (d.worker = withModel(models, d.worker, v)))} />
					</div>
					<div class="fld">
						<label>Thinking</label>
						<Levels models={models} c={draft.worker} onChange={(l) => set((d) => (d.worker.thinking = l))} />
					</div>
					<label class="switch">
						<input type="checkbox" checked={draft.applyToRunning} onChange={(e) => set((d) => (d.applyToRunning = (e.target as HTMLInputElement).checked))} />
						<span class="track" />
						Running workers switch too, at their next turn
					</label>
					<div class="fld">
						<label>Start in</label>
						<input class="txt mono" value={draft.startDir} onInput={(e) => set((d) => (d.startDir = (e.target as HTMLInputElement).value))} />
					</div>
					<p class="hint tight">Workers start here and find their way to the work from their brief.</p>
					<div class="fld">
						<label>Memory limit</label>
						<div class="seg">
							{["25%", "50%", "75%", ""].map((m) => (
								<button type="button" class={(draft.memoryMax ?? "50%") === m ? "on" : ""} onClick={() => set((d) => (d.memoryMax = m))}>
									{m || "none"}
								</button>
							))}
						</div>
					</div>
					<p class="hint tight">
						For each agent with everything it runs, as a share of this machine's RAM. If a command eats the memory, only that command is killed; pi carries on.
						Applies when an agent (re)starts.
					</p>
				</section>

				{workers.length > 0 && (
					<section class="set">
						<h2>Per worker</h2>
						<p class="hint">Give one worker its own model. Applies at its next turn.</p>
						<div class="ovl">
							{workers.map((w) => {
								const o = draft.overrides[w.name];
								return (
									<div class="ov">
										<div class="ovh">
											<Dot s={shown(s, w)} />
											<b>{w.name}</b>
											<span class="mono faint">
												{shortModel(w.model)} · {w.thinking}
											</span>
											<span class="sp" />
											<label class="switch sm">
												<input
													type="checkbox"
													checked={!!o}
													onChange={(e) =>
														set((d) => {
															if ((e.target as HTMLInputElement).checked) d.overrides[w.name] = { ...d.worker };
															else delete d.overrides[w.name];
														})
													}
												/>
												<span class="track" />
												own model
											</label>
										</div>
										{o && (
											<div class="ovb">
												<ModelSelect models={models} value={o.model} onChange={(v) => set((d) => (d.overrides[w.name] = withModel(models, o, v)))} />
												<Levels models={models} c={o} onChange={(l) => set((d) => (d.overrides[w.name].thinking = l))} />
											</div>
										)}
									</div>
								);
							})}
						</div>
					</section>
				)}

				<section class="set">
					<h2>When the boss asks you</h2>
					<p class="hint">Plain guidance, not a rulebook. It goes into the boss's prompt.</p>
					<textarea class="txt" rows={5} value={guidance} onInput={(e) => setGuidance((e.target as HTMLTextAreaElement).value)} />
					{guidance.trim() !== data.defaultGuidance.trim() && (
						<button class="link small" onClick={() => setGuidance(data.defaultGuidance)}>
							Reset to the default text
						</button>
					)}
				</section>

				<section class="set">
					<h2>This device</h2>
					<div class="fld">
						<label>Opens on</label>
						<div class="seg">
							{["boss", "overview"].map((h) => (
								<button
									type="button"
									class={home === h ? "on" : ""}
									onClick={() => {
										setHome(h);
										localStorage.setItem("np-home", h);
									}}
								>
									{h === "boss" ? "Boss chat" : "Overview"}
								</button>
							))}
						</div>
					</div>
					<div class="fld">
						<label>Terminal text</label>
						<div class="seg">
							{["10", "11", "12", "13", "14", "16"].map((f) => (
								<button
									type="button"
									class={font === f ? "on" : ""}
									onClick={() => {
										setFont(f);
										localStorage.setItem("np-font-phone", f);
										localStorage.setItem("np-font-desk", f);
									}}
								>
									{f}
								</button>
							))}
						</div>
					</div>
					<div class="fld">
						<label>Voice</label>
						<span class="small faint">
							{voiceInfo()}
							{secureHere(s.secureUrl) && (
								<>
									{" "}
									<a href={secureHere(s.secureUrl)}>Open the HTTPS address</a>
								</>
							)}
						</span>
					</div>
				</section>

				<section class="set">
					<h2>Providers</h2>
					<p class="hint">
						What pi can use right now. Log in to more with <span class="mono">/login</span> in any pi.
					</p>
					<div class="provs">
						{Object.entries(provs).map(([p, n]) => (
							<span class="prov">
								<b class="mono">{p}</b>
								<span class="faint">{n}</span>
							</span>
						))}
					</div>
				</section>
				<p class="hint center mono">
					{s.version ? `perch ${s.version} · ` : ""}files in {s.home}
				</p>
			</div>
			{(dirty || msg) && (
				<div class={`savebar ${dirty ? "" : "ok"}`}>
					<span>{dirty ? "Unsaved changes" : msg}</span>
					{dirty && (
						<>
							<button
								class="btn ghost"
								onClick={() => {
									setDraft(structuredClone(data.settings));
									setGuidance(data.guidance);
								}}
							>
								Discard
							</button>
							<button class="btn go" disabled={saving} onClick={save}>
								<Icon n="enter" size={14} /> {saving ? "Saving…" : "Save"}
							</button>
						</>
					)}
					{!dirty && msg && (
						<button class="iconbtn" onClick={() => setMsg("")} aria-label="Dismiss">
							<Icon n="x" size={16} />
						</button>
					)}
				</div>
			)}
		</div>
	);
}
