import { resolve, join, relative, basename } from "node:path";
import { realpath } from "node:fs/promises";
import {
  tmux,
  tmuxPrefix,
  sessions,
  projectPath,
  validName,
  validSessionId,
  viewerPrefix,
  sessionIdentity,
} from "./tmux";
import { headers, json, requestRejection } from "./security";
import { isTerminalResponse } from "../src/terminal-protocol";
import { MAX_IMAGE_BYTES, storeImage } from "./images";
import { watchViewer } from "./clipboard";
import { readConfig } from "./config";
import {
  backends,
  backendDefinitions,
  paneBackend,
  terminalCommand,
} from "./backends";
import type { BackendId, Session } from "../src/types";
import {
  statusLaunch,
  startAttention,
  syncAttention,
  stopAttention,
} from "./agent-status";
import { MODEL_PATH, RUNTIME_PATH } from "../src/speech-model";

const config = readConfig();
const {
  port,
  projectsRoot,
  origins,
  publicOrigin,
  distDir: dist,
  stateDir,
} = config;
let creating = false;

// Reap only our crash leftovers. Shared windows remain in the user's sessions.
try {
  const stale = await tmux(
    "list-sessions",
    "-F",
    "#{session_id}\t#{session_name}",
  );
  for (const line of stale.split("\n")) {
    const [id, name] = line.split("\t");
    if (name?.startsWith(viewerPrefix))
      await tmux("kill-session", "-t", id).catch(() => {});
  }
} catch (error) {
  if (!/no server running|no sessions|error connecting/.test(String(error)))
    console.error("Could not clean stale viewers:", error);
}

async function getSession(id: string) {
  if (!validSessionId(id)) throw new Error("Invalid session");
  const session = (await sessions()).find((s) => s.id === id);
  if (!session) throw new Error("Session no longer exists");
  return session;
}

type SocketData = {
  session: Session;
  windowId?: string;
  control: boolean;
  fit: boolean;
  cols: number;
  rows: number;
  viewer?: string;
  viewerName?: string;
  proc?: Bun.Subprocess;
  observer?: Bun.Subprocess;
  closed?: boolean;
  decoder: TextDecoder;
  writes?: Promise<void>;
  redraw?: ReturnType<typeof setTimeout>;
  paneId?: string;
  opening?: Promise<void>;
  cleanup?: Promise<void>;
};

const liveSockets = new Set<Bun.ServerWebSocket<SocketData>>();
const killing = new Set<string>();

function closeTerminal(ws: Bun.ServerWebSocket<SocketData>) {
  const d = ws.data;
  if (d.cleanup) return d.cleanup;
  d.closed = true;
  clearTimeout(d.redraw);
  d.proc?.terminal?.close();
  d.proc?.kill();
  d.observer?.kill();
  // Keep pending opens registered until their viewer has been removed too.
  return (d.cleanup ??= (async () => {
    await d.opening;
    if (d.viewer) {
      await tmux(
        "if-shell",
        "-F",
        "-t",
        d.viewer,
        `#{==:#{session_name},${d.viewerName}}`,
        `kill-session -t ${d.viewer}`,
      ).catch((error) => {
        if (
          !/can't find session|no server running|no sessions/.test(
            String(error),
          )
        )
          throw error;
      });
    }
    liveSockets.delete(ws);
  })());
}

const server = Bun.serve<SocketData>({
  hostname: config.host,
  port,
  maxRequestBodySize: MAX_IMAGE_BYTES + 1,
  idleTimeout: 30,
  async fetch(req, server) {
    const url = new URL(req.url);
    const rejection = requestRejection(
      req,
      origins,
      !["GET", "HEAD"].includes(req.method),
    );
    if (rejection) {
      const reference = crypto.randomUUID().slice(0, 8);
      // No credentials, query strings, bodies, or terminal content in diagnostics.
      console.warn("Request rejected", {
        reference,
        reason: rejection,
        method: req.method,
        path: url.pathname.slice(0, 128),
      });
      return json(
        { error: `Origin not allowed (${rejection}; reference ${reference})` },
        403,
      );
    }
    try {
      if (url.pathname === "/api/images" && req.method === "POST") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES)
          return json({ error: "Image exceeds 10 MiB." }, 413);
        const path = await storeImage(
          bytes,
          req.headers.get("content-type") || "",
          stateDir,
        );
        return json({ path }, 201);
      }
      if (url.pathname === "/terminal") {
        if (
          req.method !== "GET" ||
          !origins.has(req.headers.get("origin") || "")
        )
          return json({ error: "Origin required" }, 403);
        const session = await getSession(url.searchParams.get("session") || "");
        if (Number(url.searchParams.get("created")) !== session.created)
          return json({ error: "Session has changed. Select it again." }, 409);
        if (killing.has(session.id))
          return json({ error: "Session is being killed" }, 409);
        const windowId = url.searchParams.get("window") || undefined;
        if (windowId && !session.panes.some((p) => p.windowId === windowId))
          return json({ error: "Window not found" }, 404);
        const upgraded = server.upgrade(req, {
          data: {
            session,
            windowId,
            control: url.searchParams.get("control") === "1",
            fit: url.searchParams.get("fit") === "1",
            cols: Math.max(
              20,
              Math.min(
                300,
                Math.floor(Number(url.searchParams.get("cols"))) || 80,
              ),
            ),
            rows: Math.max(
              5,
              Math.min(
                120,
                Math.floor(Number(url.searchParams.get("rows"))) || 24,
              ),
            ),
            decoder: new TextDecoder(),
          },
        });
        return upgraded ? undefined : json({ error: "Upgrade failed" }, 400);
      }
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const list = await sessions();
        await Promise.all(
          list.flatMap((s) =>
            s.panes.map(async (p) => {
              p.backend = await paneBackend(p);
            }),
          ),
        );
        return json({
          sessions: list,
          projectsRoot,
          backends: backends(),
          voiceReady: await Bun.file(
            join(dist, MODEL_PATH, "ready.json"),
          ).exists(),
        });
      }
      if (url.pathname === "/api/sessions/kill" && req.method === "POST") {
        const bytes = await req.arrayBuffer();
        if (bytes.byteLength > 262144)
          return json({ error: "Request is too large." }, 413);
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (
          typeof body?.id !== "string" ||
          !validSessionId(body.id) ||
          !Number.isSafeInteger(body.created) ||
          body.created < 0
        )
          return json({ error: "Invalid session identity" }, 400);
        if (killing.has(body.id))
          return json({ error: "Session is being killed" }, 409);
        killing.add(body.id);
        try {
          const session = await getSession(body.id);
          if (session.created !== body.created)
            return json(
              { error: "Session has changed. Select it again." },
              409,
            );
          await Promise.all(
            [...liveSockets]
              .filter(
                ({ data }) =>
                  data.session.id === session.id &&
                  data.session.created === session.created,
              )
              .map((ws) => {
                const cleanup = closeTerminal(ws);
                ws.close(1000, "Session killed");
                return cleanup;
              }),
          );
          // No shell job/yield between the tmux identity check and mutation.
          // Shared windows owned by non-Perch sessions deliberately survive.
          const result = await tmux(
            "if-shell",
            "-F",
            "-t",
            session.id,
            sessionIdentity(session),
            `kill-session -t ${session.id} ; display-message -p killed`,
            "display-message -p stale",
          );
          if (result !== "killed")
            return json(
              { error: "Session has changed. Select it again." },
              409,
            );
          return json({ ok: true });
        } finally {
          killing.delete(body.id);
        }
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        if (creating)
          return json({ error: "Another session is being created" }, 409);
        creating = true;
        let id: string | undefined;
        try {
          const bytes = await req.arrayBuffer();
          if (bytes.byteLength > 262144)
            return json({ error: "Request is too large." }, 413);
          const body = JSON.parse(new TextDecoder().decode(bytes));
          const backend: BackendId = body?.backend ?? "opencode";
          if (
            !body ||
            typeof backend !== "string" ||
            !Object.hasOwn(backendDefinitions, backend) ||
            (body.name !== undefined &&
              body.name !== "" &&
              !validName(body.name)) ||
            typeof body.directory !== "string" ||
            (body.createDirectory !== undefined &&
              typeof body.createDirectory !== "boolean") ||
            (body.prompt !== undefined &&
              (typeof body.prompt !== "string" || body.prompt.length > 32000))
          )
            return json({ error: "Invalid name, directory, or prompt" }, 400);
          const names = new Set((await sessions()).map((s) => s.name));
          if (body.name && names.has(body.name))
            throw new Error("A tmux session with that name already exists");
          // Validate executable and prompt before creating anything on disk.
          terminalCommand(backend, body.directory, body.prompt || "");
          const directory = await projectPath(
            projectsRoot,
            body.directory,
            body.createDirectory === true,
          );
          const base =
            basename(directory)
              .replace(/[^a-zA-Z0-9_-]/g, "-")
              .replace(/^[^a-zA-Z0-9]+/, "")
              .slice(0, 40) || "session";
          let name = body.name || base;
          for (let suffix = 2; !body.name && names.has(name); suffix++)
            name = `${base}-${suffix}`;
          // A long-lived tmux server may have an older environment than Perch.
          const { environment } = backendDefinitions[backend];
          const env = ["HOME", "PATH", ...environment]
            .filter((key) => process.env[key] !== undefined)
            .flatMap((key) => ["-e", `${key}=${process.env[key]}`]);
          const native = await statusLaunch(backend, stateDir);
          const run = crypto.randomUUID();
          env.push(
            "-e",
            `PERCH_RUN_ID=${run}`,
            "-e",
            `PERCH_TMUX=${tmuxPrefix[0]}`,
            "-e",
            `PERCH_BUN=${process.execPath}`,
            ...native.environment.flatMap((entry) => ["-e", entry]),
          );
          id = await tmux(
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{session_id}",
            "-s",
            name,
            // tmux expands formats in -c even with literal command argv.
            "-c",
            directory.replaceAll("#", "##"),
            "-x",
            "100",
            "-y",
            "30",
            ...env,
            Bun.which("sh") || "/bin/sh",
            resolve(import.meta.dir, "../scripts/launch-agent.sh"),
            ...terminalCommand(
              backend,
              directory,
              body.prompt || "",
              process.env,
              native.args,
            ),
          );
          const launched = await getSession(id);
          const first = launched.panes[0];
          if (!first) throw new Error("The new session has no terminal pane.");
          for (const [name, value] of Object.entries({
            "@perch_run": run,
            "@perch_backend": backend,
            "@perch_pid": String(first.pid),
          }))
            await tmux("set-option", "-p", "-t", first.id, name, value);
          await syncAttention();
          await tmux("wait-for", "-S", run);
          await getSession(id);
          return json({ id }, 201);
        } catch (error) {
          if (id) await tmux("kill-session", "-t", id).catch(() => {});
          throw error;
        } finally {
          creating = false;
        }
      }
      if (
        url.pathname.startsWith("/api/") ||
        !["GET", "HEAD"].includes(req.method)
      )
        return json({ error: "Not found" }, 404);
      const requested = decodeURIComponent(
        url.pathname === "/" ? "/index.html" : url.pathname,
      );
      const filePath = resolve(dist, "." + requested);
      if (
        !relative(dist, filePath) ||
        relative(dist, filePath).startsWith("..")
      )
        return json({ error: "Not found" }, 404);
      const actual = await realpath(filePath).catch(() => undefined);
      if (!actual || relative(dist, actual).startsWith(".."))
        return json({ error: "Not found" }, 404);
      const file = Bun.file(actual);
      // Emscripten's bindings generate functions inside speech workers, never the page.
      // Blob imports also keep already-open Whisper clients working during rollout.
      const assetHeaders =
        requested.startsWith("/assets/voice.worker-") ||
        requested === `${RUNTIME_PATH}/moonshine.mjs`
          ? {
              ...headers,
              "Content-Security-Policy": headers[
                "Content-Security-Policy"
              ].replace(
                "script-src 'self'",
                "script-src 'self' blob: 'unsafe-eval'",
              ),
            }
          : headers;
      return new Response(req.method === "HEAD" ? null : file, {
        headers: {
          ...assetHeaders,
          "Content-Type": file.type,
          "Content-Length": String(file.size),
          "Cache-Control": /\/(assets|models|ort|speech)\//.test(requested)
            ? "private, max-age=86400"
            : "no-cache",
        },
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Request failed" },
        400,
      );
    }
  },
  websocket: {
    maxPayloadLength: 262144,
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    async open(ws) {
      const d = ws.data;
      liveSockets.add(ws);
      d.opening = (async () => {
        try {
          if (d.closed || killing.has(d.session.id))
            throw new Error("Session is being killed");
          d.viewerName = viewerPrefix + crypto.randomUUID().replaceAll("-", "");
          d.viewer = await tmux(
            "if-shell",
            "-F",
            "-t",
            d.session.id,
            sessionIdentity(d.session),
            `new-session -d -P -F '#{session_id}' -s ${d.viewerName} -t ${d.session.id}`,
            "display-message -p stale",
          );
          if (!validSessionId(d.viewer)) {
            d.viewer = undefined;
            throw new Error("Session has changed. Select it again.");
          }
          if (d.closed) return;
          await tmux("set-option", "-t", d.viewer, "status", "off");
          // Change our viewer only, never the user's mouse or sizing preferences.
          await tmux("set-option", "-t", d.viewer, "mouse", "on");
          if (d.windowId)
            await tmux("select-window", "-t", `${d.viewer}:${d.windowId}`);
          if (d.closed) return;
          const flags = d.control
            ? d.fit
              ? ""
              : "ignore-size"
            : "read-only,ignore-size";
          d.proc = Bun.spawn(
            [
              ...tmuxPrefix,
              "attach-session",
              "-E",
              ...(flags ? ["-f", flags] : []),
              "-t",
              d.viewer,
            ],
            {
              env: {
                ...process.env,
                TMUX: "",
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
              },
              terminal: {
                cols: d.cols,
                rows: d.rows,
                data(_term, bytes) {
                  if (!d.closed)
                    ws.send(
                      JSON.stringify({
                        type: "output",
                        data: d.decoder.decode(bytes, { stream: true }),
                      }),
                    );
                },
              },
              onExit() {
                if (!d.closed) ws.close(1000, "Terminal detached");
              },
            },
          );
          if (d.closed) return;
          d.observer = watchViewer(
            d.viewer,
            (paneId, initial) => {
              if (d.closed) return;
              d.paneId = paneId;
              ws.send(
                JSON.stringify({
                  type: initial ? "ready" : "pane",
                  paneId,
                  viewerId: d.viewer,
                }),
              );
            },
            (paneId, text) => {
              void (async () => {
                if (d.closed) return;
                const visible = await tmux(
                  "display-message",
                  "-p",
                  "-t",
                  d.viewer!,
                  "#{pane_id}",
                );
                if (!d.closed && d.paneId === paneId && visible === paneId)
                  ws.send(JSON.stringify({ type: "clipboard", paneId, text }));
              })().catch(() => {});
            },
            () => {
              if (!d.closed) ws.close(1011, "Viewer observation stopped");
            },
          );
        } catch (error) {
          if (!d.closed) {
            ws.send(JSON.stringify({ type: "error", message: String(error) }));
            ws.close(1011);
          }
        }
      })();
      await d.opening;
    },
    message(ws, raw) {
      const d = ws.data;
      if (d.closed) return;
      try {
        if (typeof raw !== "string") throw new Error("Expected JSON");
        const msg = JSON.parse(raw);
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (
          msg.type === "response" &&
          typeof msg.data === "string" &&
          isTerminalResponse(msg.data)
        ) {
          d.proc?.terminal?.write(msg.data);
          return;
        }
        if (msg.type === "paste") {
          if (
            typeof msg.id !== "string" ||
            !/^[a-zA-Z0-9-]{16,64}$/.test(msg.id) ||
            typeof msg.data !== "string" ||
            msg.data.length > 64000 ||
            msg.submit !== false
          )
            throw new Error("Invalid paste");
          d.writes = (d.writes || Promise.resolve()).then(async () => {
            try {
              if (d.closed || !d.proc?.terminal)
                throw new Error(
                  "Terminal disconnected. Check delivery before resending.",
                );
              if (!d.control)
                throw new Error("Terminal is read-only. Text was not sent.");
              const [target, command, pid] = (
                await tmux(
                  "display-message",
                  "-p",
                  "-t",
                  d.viewer!,
                  "#{pane_id}\t#{pane_current_command}\t#{pane_pid}",
                )
              ).split("\t");
              if (msg.opencodeOnly && command !== "opencode")
                throw new Error(
                  "The selected pane is no longer OpenCode. Text was not pasted.",
                );
              if (msg.backend !== undefined) {
                if (!["opencode", "pi"].includes(msg.backend))
                  throw new Error("Unsupported paste backend.");
                const backend = await paneBackend({
                  id: target!,
                  command: command!,
                  pid: Number(pid),
                  dead: false,
                } as import("../src/types").Pane);
                if (backend !== msg.backend)
                  throw new Error(
                    "The selected agent changed. Text was not pasted.",
                  );
                const identity = await tmux(
                  "display-message",
                  "-p",
                  "-t",
                  d.viewer!,
                  "#{pane_id}\t#{pane_pid}",
                );
                if (identity !== `${target}\t${pid}`)
                  throw new Error(
                    "The displayed process changed. Text was not pasted.",
                  );
              }
              if (msg.paneId && msg.paneId !== target)
                throw new Error(
                  "The displayed pane changed. Review the terminal before sending.",
                );
              // The viewer may have disconnected while tmux answered the identity check.
              if (d.closed)
                throw new Error(
                  "Terminal disconnected. Check delivery before resending.",
                );
              d.proc.terminal.write(msg.data);
              ws.send(JSON.stringify({ type: "input-ack", id: msg.id }));
            } catch (error) {
              if (!d.closed)
                ws.send(
                  JSON.stringify({
                    type: "input-ack",
                    id: msg.id,
                    error:
                      error instanceof Error ? error.message : "Input failed",
                  }),
                );
            }
          });
          return;
        }
        if (
          msg.type === "input" &&
          d.control &&
          typeof msg.data === "string" &&
          msg.data.length <= 32000
        )
          d.proc?.terminal?.write(msg.data);
        if (
          msg.type === "resize" &&
          Number.isInteger(msg.cols) &&
          Number.isInteger(msg.rows)
        ) {
          d.proc?.terminal?.resize(
            Math.max(20, Math.min(300, msg.cols)),
            Math.max(5, Math.min(120, msg.rows)),
          );
          clearTimeout(d.redraw);
          d.redraw = setTimeout(async () => {
            if (d.closed || !d.viewer) return;
            try {
              const clients = await tmux(
                "list-clients",
                "-t",
                d.viewer,
                "-F",
                "#{client_name}",
              );
              for (const client of clients.split("\n").filter(Boolean))
                if (!d.closed) await tmux("refresh-client", "-t", client);
            } catch {}
          }, 100);
        }
      } catch {
        ws.close(1008, "Invalid message");
      }
    },
    close(ws) {
      void closeTerminal(ws).catch((error) => {
        console.error("Could not clean viewer:", error);
      });
    },
  },
});
startAttention();
console.log(
  `Agent Perch listening on ${server.url}; public origin: ${publicOrigin || "(local only)"}`,
);
async function shutdown() {
  stopAttention();
  await server.stop(true);
  await Bun.sleep(300);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
