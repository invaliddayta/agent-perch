// perch's service worker (%HOST% is filled in by web/build.ts). It activates at once and only
// handles page loads: they always come from the network, and if %HOST% can't be reached, a small
// offline page says so instead of the browser's error page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>perch</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:16px system-ui,sans-serif;text-align:center}
p{color:#8b93a1;margin:.5em 2em 1.5em}button{font:inherit;padding:.6em 1.4em;border-radius:10px;border:0;background:#f5c451;color:#0b0d10;font-weight:600}</style>
<div><h2>perch can't reach %HOST%</h2><p>Check that this device can reach it (VPN, Tailscale), then try again.</p><button onclick="location.reload()">Try again</button></div>
<script>addEventListener("online",()=>location.reload())</script>`;

self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return; // everything else goes straight to the network
	event.respondWith(
		fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } })),
	);
});
