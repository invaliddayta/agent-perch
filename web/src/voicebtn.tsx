/** Mic button: on-device English speech (Moonshine, from Agent Perch v1). Tap to talk, tap to stop. */
import { useEffect, useState } from "preact/hooks";
import { useSnap } from "./store.ts";
import { Icon } from "./ui.tsx";
import { createVoice, type Voice, type VoiceState } from "./voice.ts";

let voice: Voice | undefined;
let state: VoiceState = { phase: "unloaded", message: "Voice is not loaded." };
let sink: ((t: string) => void) | undefined;
const subs = new Set<() => void>();

const usable = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

/** The same page on the dashboard's HTTPS address, when there is one and this is not it. */
export function secureHere(url?: string) {
	return url && !window.isSecureContext ? `${url}/${location.hash}` : undefined;
}

export function voiceInfo() {
	if (!usable()) return "Needs the HTTPS address of this dashboard (browsers only allow the microphone there).";
	if (state.phase === "ready") return "On-device speech is loaded. Nothing leaves this device.";
	return "English, on this device (Moonshine). The first use downloads the ~300 MB model once.";
}

function get(): Voice {
	return (voice ??= createVoice(
		(s) => {
			state = s;
			subs.forEach((f) => f());
		},
		(text) => sink?.(text),
	));
}

export function VoiceButton({ onText }: { onText: (t: string) => void }) {
	const [, set] = useState(0);
	const [note, setNote] = useState("");
	const go = secureHere(useSnap()?.secureUrl);
	useEffect(() => {
		const f = () => set((n) => n + 1);
		subs.add(f);
		return () => void subs.delete(f);
	}, []);
	useEffect(() => {
		if (state.phase === "error") setNote(state.message);
	}, [state.phase, state.message]);
	useEffect(() => {
		if (!note) return;
		const t = setTimeout(() => setNote(""), 6000);
		return () => clearTimeout(t);
	}, [note]);

	const ph = state.phase;
	async function tap() {
		setNote("");
		if (!usable()) return setNote(voiceInfo());
		sink = onText;
		try {
			if (ph === "recording") await get().stop();
			else if (ph === "transcribing") return;
			else await get().start();
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		}
	}
	const loading = ph === "loading" && state.progress !== undefined;
	return (
		<span class="voice">
			<button
				type="button"
				class={`micbtn ${ph} ${usable() ? "" : "off"}`}
				aria-label={ph === "recording" ? "Stop and transcribe" : "Dictate"}
				title={ph === "recording" ? "Stop and transcribe" : "Dictate (on-device)"}
				onClick={tap}
			>
				{ph === "recording" ? <Icon n="stop" size={16} /> : ph === "transcribing" ? <span class="spin" /> : <Icon n="mic" size={18} />}
			</button>
			{(note || loading || ph === "recording" || ph === "transcribing") && (
				<span class={`vnote ${note && !(go && !usable()) ? "err" : ""}`}>
					{note && go && !usable() ? (
						<>
							The mic needs the secure address: <a href={go}>open it</a>
						</>
					) : note || (loading ? `loading speech model ${Math.round(state.progress!)}%` : ph === "recording" ? "listening… tap ■ to stop" : "transcribing…")}
				</span>
			)}
		</span>
	);
}
