/**
 * Bundles the page (web/src) into web/dist. The server runs this at startup, so a restart is
 * a deploy. `bun web/build.ts` builds by hand.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const DIST = join(import.meta.dir, "dist");

export async function build(): Promise<void> {
	const src = join(import.meta.dir, "src");
	rmSync(DIST, { recursive: true, force: true });
	mkdirSync(DIST, { recursive: true });
	const r = await Bun.build({
		entrypoints: [join(src, "main.tsx"), join(src, "voice.worker.ts")],
		outdir: join(DIST, "assets"),
		target: "browser",
		format: "esm",
		minify: true,
		sourcemap: "linked",
		publicPath: "/assets/",
		naming: { entry: "[name].[ext]", asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!r.success) {
		for (const log of r.logs) console.error(log);
		throw new Error("page build failed");
	}
	// Bust caches per build: assets are cached by the browser, the page is not.
	const id = Date.now().toString(36);
	const page = (await Bun.file(join(src, "index.html")).text()).replace(/(\/assets\/main\.(?:js|css))/g, `$1?b=${id}`);
	await Bun.write(join(DIST, "index.html"), page);
	mkdirSync(join(DIST, "fonts"));
	for (const f of ["term-mono-Regular.woff2", "term-mono-Bold.woff2"]) cpSync(join(src, "fonts", f), join(DIST, "fonts", f));
	const inter = join(import.meta.dir, "node_modules/@fontsource-variable/inter/files");
	for (const f of ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2"]) cpSync(join(inter, f), join(DIST, "fonts", f));
	for (const f of ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) cpSync(join(src, f), join(DIST, f));
	// This machine's name, in the app's description and in the offline page.
	for (const f of ["manifest.webmanifest", "sw.js"]) await Bun.write(join(DIST, f), (await Bun.file(join(src, f)).text()).replaceAll("%HOST%", hostname()));
}

if (import.meta.main) {
	const t = performance.now();
	await build();
	console.log(`built web/dist in ${Math.round(performance.now() - t)} ms`);
}
