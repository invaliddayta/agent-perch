/**
 * Puts the on-device speech model (Moonshine, English, ~300 MB) and its WASM runtime into
 * web/voice/, which the server serves at /models and /speech. Downloads the pinned model files
 * from download.moonshine.ai (skipping those already there) and copies the runtime from web/node_modules.
 */
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_FILES, MODEL_PATH, MODEL_URL, RUNTIME_PATH } from "../web/src/speech-model.ts";

const root = join(import.meta.dir, "..", "web", "voice");
const modelDir = join(root, MODEL_PATH);
const runtimeDir = join(root, RUNTIME_PATH);
mkdirSync(modelDir, { recursive: true });

for (const [file, size] of Object.entries(MODEL_FILES)) {
	const dest = join(modelDir, file);
	if (existsSync(dest) && statSync(dest).size === size) continue;
	const r = await fetch(`${MODEL_URL}/${file}`);
	if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
	await Bun.write(dest, await r.arrayBuffer());
	if (statSync(dest).size !== size) throw new Error(`${file}: wrong size`);
	console.log(`${file} ${(size / 2 ** 20).toFixed(1)} MiB`);
}
const runtime = dirname(fileURLToPath(import.meta.resolve("@moonshine-ai/moonshine-wasm", join(import.meta.dir, "..", "web", "package.json"))));
cpSync(runtime, runtimeDir, { recursive: true });
console.log(`voice ready in ${root}`);
