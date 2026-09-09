export function requestRejection(
  req: Request,
  origins: Set<string>,
  mutation = false,
) {
  const host = req.headers.get("host");
  if (!host || ![...origins].some((o) => new URL(o).host === host))
    return "host";
  // Installed Android launches use navigate with dest=empty (or document).
  // Only the static entry document is navigable this way, never APIs or sockets.
  if (
    !mutation &&
    req.method === "GET" &&
    ["/", "/index.html"].includes(new URL(req.url).pathname) &&
    req.headers.get("sec-fetch-mode") === "navigate" &&
    ["document", "empty"].includes(req.headers.get("sec-fetch-dest") || "")
  )
    return undefined;
  const origin = req.headers.get("origin");
  if (origin && !origins.has(origin)) return "origin";
  if (req.headers.get("sec-fetch-site") === "cross-site") return "fetch-site";
  if (
    mutation &&
    (!origin ||
      !origins.has(origin) ||
      req.headers.get("x-agent-watch") !== "1")
  )
    return "mutation-headers";
  return undefined;
}

export function allowedRequest(
  req: Request,
  origins: Set<string>,
  mutation = false,
) {
  return requestRejection(req, origins, mutation) === undefined;
}

export const headers = {
  Vary: "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}
