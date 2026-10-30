/**
 * HTTP and HTTPS on one port. Phones only allow the microphone and the clipboard on secure pages,
 * and the plain http address must keep working as a fallback.
 *
 * A small TCP front on PERCH_HOST:PERCH_PORT looks at the first byte of each connection: a TLS
 * handshake goes to an internal HTTPS server, anything else to an internal HTTP server. Both serve
 * the same app. So http://100.x.y.z:4320/ and https://<machine>.<tailnet>.ts.net:4320/ both work.
 *
 * The certificate comes from `tailscale cert` (needs `tailscale set --operator=$USER` once) for this
 * machine's tailnet name, or PERCH_TLS_DOMAIN. It is kept in PERCH_HOME/tls. If fetching fails,
 * the front serves HTTP only and retries hourly; HTTPS switches on by itself once it works. Renewal
 * swaps in a new internal server without a restart. PERCH_TLS=off: plain HTTP, no front.
 *
 * At boot the Tailscale address may not exist yet. Binding it is retried every few seconds until it
 * works (the 127.0.0.1 listener of server.ts is up meanwhile), and HTTPS is retried every minute
 * until it is on, with the certificate already on disk if tailscale cannot tell the name yet.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { home } from "../ext/store.ts";

const DAY = 86400_000;
export type Serve = (o: { hostname: string; port: number; tls?: { cert: string; key: string } }) => { port?: number; stop(): void };

export interface Listening {
	/** The plain address. */
	http: string;
	/** The HTTPS address, once there is a certificate. */
	https(): string | undefined;
}

function expires(cert: string): number {
	try {
		return new Date(new X509Certificate(cert).validTo).getTime();
	} catch {
		return 0;
	}
}

function tailnetName(): string | undefined {
	if (process.env.PERCH_TLS_DOMAIN) return process.env.PERCH_TLS_DOMAIN;
	const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 10_000 });
	try {
		const name = (JSON.parse(r.stdout).Self?.DNSName as string | undefined)?.replace(/\.$/, "");
		if (name) return name;
	} catch {}
	// tailscaled not up yet (boot): the one certificate we already have.
	try {
		const have = readdirSync(join(home(), "tls")).filter((f) => f.endsWith(".crt"));
		if (have.length === 1) return have[0].slice(0, -4);
	} catch {}
}

/** Bind, retrying every 5 s while it fails (at boot the Tailscale address comes up later). */
function bindLater(what: string, bind: (ok: () => void, failed: (e: Error) => void) => void) {
	let said = false;
	const attempt = () =>
		bind(
			() => said && console.log(`listening on ${what} now`),
			(e) => {
				if (!said) console.error(`cannot listen on ${what} yet (${e.message}); retrying every 5 s`);
				said = true;
				setTimeout(attempt, 5000);
			},
		);
	attempt();
}

/** A certificate valid for at least 30 more days, fetching a new one if needed. Undefined if there is none. */
function certificate(domain: string): { cert: string; key: string; error?: string } | undefined {
	const dir = join(home(), "tls");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const crt = join(dir, `${domain}.crt`);
	const key = join(dir, `${domain}.key`);
	const read = () => (existsSync(crt) && existsSync(key) ? { cert: readFileSync(crt, "utf8"), key: readFileSync(key, "utf8") } : undefined);
	let have = read();
	let error: string | undefined;
	if (!have || expires(have.cert) - Date.now() < 30 * DAY) {
		const r = spawnSync("tailscale", ["cert", "--cert-file", crt, "--key-file", key, domain], { encoding: "utf8", timeout: 120_000 });
		if (r.status !== 0) error = (r.stderr || r.stdout || String(r.error)).trim().split("\n")[0];
		if (existsSync(key)) chmodSync(key, 0o600);
		have = read();
	}
	if (have && expires(have.cert) > Date.now()) return { ...have, error };
	if (error && error !== lastError) console.error(`no HTTPS yet: tailscale cert ${domain}: ${error} (retrying every minute; said once)`);
	lastError = error;
}
let lastError: string | undefined;

export function listen(serve: Serve, hostname: string, port: number): Listening {
	const http = `http://${hostname}:${port}`;
	if (process.env.PERCH_TLS === "off") {
		bindLater(http, (ok, failed) => {
			try {
				serve({ hostname, port });
				ok();
			} catch (e) {
				failed(e as Error);
			}
		});
		return { http, https: () => undefined };
	}

	const plain = serve({ hostname: "127.0.0.1", port: 0 });
	let secure: { server: { port?: number; stop(): void }; until: number; domain: string } | undefined;

	function refresh() {
		const domain = tailnetName();
		if (!domain) return;
		if (secure && secure.domain === domain && secure.until - Date.now() > 30 * DAY) return;
		const c = certificate(domain);
		if (!c) return;
		const until = expires(c.cert);
		if (secure && secure.domain === domain && until <= secure.until) return; // renewal failed; keep the old one
		if (c.error) console.error(`tailscale cert ${domain} (keeping the current one): ${c.error}`);
		const old = secure;
		secure = { server: serve({ hostname: "127.0.0.1", port: 0, tls: { cert: c.cert, key: c.key } }), until, domain };
		old?.server.stop(); // stops accepting; open connections finish
		console.log(`HTTPS on https://${domain}:${port}/ (certificate until ${new Date(until).toISOString().slice(0, 10)})`);
	}
	// Hourly is cheap when the certificate is fine; every minute until HTTPS is on (e.g. after boot).
	const tick = () => {
		refresh();
		setTimeout(tick, secure ? 3600_000 : 60_000);
	};
	tick();

	const front = createServer((c) => {
		c.on("error", () => c.destroy());
		c.once("data", (first: Buffer) => {
			c.pause();
			const to = first[0] === 0x16 ? secure?.server.port : plain.port;
			if (!to) return c.destroy();
			const up = connect(to, "127.0.0.1", () => {
				up.write(first);
				c.pipe(up);
				up.pipe(c);
				c.resume();
			});
			up.on("error", () => c.destroy());
			up.on("close", () => c.destroy());
			c.on("close", () => up.destroy());
		});
	});
	bindLater(http, (ok, failed) => {
		const onError = (e: Error) => failed(e);
		front.once("error", onError);
		front.listen(port, hostname, () => {
			front.off("error", onError);
			ok();
			front.on("error", (e) => console.error(`front ${http}: ${e.message}`));
		});
	});

	return { http, https: () => secure && `https://${secure.domain}:${port}` };
}
