import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Session } from "../src/types";

test("kill isolates session identity and drains live and pending grouped viewers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-kill-"));
  const socket = join(dir, "tmux.sock");
  const realTmux = Bun.which("tmux")!;
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [realTmux, "-S", socket, "-f", "/dev/null", ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TMUX: "" },
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(error);
    return output.trim();
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    throw new Error("Timed out waiting for fixture state");
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sockets: WebSocket[] = [];
  let server: Bun.Subprocess | undefined;
  try {
    await mkdir(join(dir, "bin"));
    // Delay one tmux invocation before execution or after execution but before
    // stdout delivery. This exercises actual WS opens and real grouped sessions.
    await writeFile(
      join(dir, "bin", "tmux"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("attach-session")) {
  const child = Bun.spawn([${JSON.stringify(realTmux)}, ...args], {stdin: "inherit", stdout: "inherit", stderr: "inherit"});
  process.on("SIGTERM", () => child.kill());
  process.exit(await child.exited);
}
const gate = Bun.file(${JSON.stringify(join(dir, "gate"))});
const config = await gate.json().catch(() => null);
const matched = config && args.some(a => a.includes(config.match));
async function pause() {
  await Bun.write(${JSON.stringify(join(dir, "blocked"))}, "blocked");
  while (await Bun.file(${JSON.stringify(join(dir, "gate"))}).exists()) await Bun.sleep(10);
}
if (matched && config.before) await pause();
const child = Bun.spawn([${JSON.stringify(realTmux)}, ...args], {stdout: "pipe", stderr: "pipe"});
const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (matched && !config.before) await pause();
process.stdout.write(out);
process.stderr.write(err);
process.exit(code);
`,
      { mode: 0o700 },
    );
    const create = async (name: string) => {
      const text = await run(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}\t#{session_created}\t#{pane_pid}",
        "-s",
        name,
        "sleep",
        "120",
      );
      const [id, created, pid] = text.split("\t");
      return { id: id!, created: Number(created), pid: Number(pid) };
    };
    const target = await create("target");
    const extraPid = Number(
      await run(
        "new-window",
        "-t",
        target.id,
        "-P",
        "-F",
        "#{pane_pid}",
        "sleep",
        "120",
      ),
    );
    const other = await create("other");
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const origin = `http://127.0.0.1:${probe.port}`;
    await probe.stop(true);
    server = Bun.spawn([process.execPath, "--no-env-file", "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        PORT: new URL(origin).port,
        TMUX_SOCKET: socket,
        PROJECTS_ROOT: dir,
        STATE_DIR: join(dir, "state"),
        DIST_DIR: join(dir, "dist"),
        OPENCODE_BIN: "/nonexistent",
        CODEX_BIN: "/nonexistent",
        DEEPSEEK_BIN: "/nonexistent",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    await until(async () =>
      fetch(origin + "/api/sessions")
        .then((r) => r.ok)
        .catch(() => false),
    );
    const headers = {
      Origin: origin,
      "X-Agent-Watch": "1",
      "Content-Type": "application/json",
    };
    const kill = (
      body: unknown,
      requestHeaders: Record<string, string> = headers,
    ) =>
      fetch(origin + "/api/sessions/kill", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
    const connect = (session: { id: string; created: number }) => {
      const Socket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const ws = new Socket(
        `${origin.replace("http:", "ws:")}/terminal?session=${encodeURIComponent(session.id)}&created=${session.created}&control=1`,
        { headers: { Origin: origin } },
      );
      sockets.push(ws);
      const messages: { type: string; viewerId?: string }[] = [];
      ws.addEventListener("message", (event) =>
        messages.push(JSON.parse(String(event.data))),
      );
      ws.addEventListener("error", () => {});
      return { ws, messages };
    };
    const ready = async (connection: ReturnType<typeof connect>) => {
      await until(() =>
        connection.messages.some((m) => m.type === "ready"),
      ).catch(() => {
        throw new Error(
          `Viewer did not become ready: ${JSON.stringify(connection.messages)}`,
        );
      });
      return connection.messages.find((m) => m.type === "ready")!.viewerId!;
    };
    const a = connect(target),
      b = connect(target),
      survivor = connect(other);
    const viewers = await Promise.all([ready(a), ready(b), ready(survivor)]);
    expect(new Set(viewers).size).toBe(3);
    for (const body of [
      null,
      {},
      { ...target, id: 0 },
      { ...target, id: "target" },
      { ...target, id: "$0; kill-server" },
      { ...target, id: "$0\n" },
      { id: target.id },
      { ...target, created: String(target.created) },
      { ...target, created: null },
      { ...target, created: 1.5 },
      { ...target, created: -1 },
      { ...target, created: 1e100 },
    ])
      expect((await kill(body)).status).toBe(400);
    expect(
      (
        await fetch(origin + "/api/sessions/kill", {
          method: "POST",
          headers,
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await kill({ ...target, created: target.created - 1 })).status,
    ).toBe(409);
    expect((await kill({ ...target, id: "$999999" })).status).toBe(400);
    const viewerCreated = Number(
      await run(
        "display-message",
        "-p",
        "-t",
        viewers[0]!,
        "#{session_created}",
      ),
    );
    expect(
      (await kill({ id: viewers[0], created: viewerCreated })).status,
    ).toBe(400);
    expect(
      (await kill(target, { ...headers, Origin: "https://attacker.invalid" }))
        .status,
    ).toBe(403);
    expect((await kill(target, { Origin: origin })).status).toBe(403);
    expect(alive(target.pid)).toBe(true);
    expect(alive(extraPid)).toBe(true);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    const gate = async (match: string, before: boolean) => {
      await rm(join(dir, "blocked"), { force: true });
      await writeFile(join(dir, "gate"), JSON.stringify({ match, before }));
    };
    const blocked = () => until(() => Bun.file(join(dir, "blocked")).exists());
    const release = () => rm(join(dir, "gate"), { force: true });
    await gate("new-session -d -P", false);
    const pending = connect(target);
    await blocked();
    const deletion = kill(target);
    await until(
      () =>
        a.ws.readyState === WebSocket.CLOSED &&
        b.ws.readyState === WebSocket.CLOSED,
    );
    // The pending viewer exists in tmux, but its creation promise hasn't resolved.
    expect(alive(target.pid)).toBe(true);
    expect((await kill(target)).status).toBe(409);
    const refused = connect(target);
    await until(() => refused.ws.readyState === WebSocket.CLOSED);
    await release();
    const result = await deletion;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    await until(() => !alive(target.pid) && !alive(extraPid));
    await until(() => pending.ws.readyState === WebSocket.CLOSED);
    expect(pending.messages.some((m) => m.type === "ready")).toBe(false);
    expect(
      (await run("list-sessions", "-F", "#{session_id}")).split("\n").sort(),
    ).toEqual([other.id, viewers[2]!].sort());
    expect(alive(other.pid)).toBe(true);
    survivor.ws.send(JSON.stringify({ type: "ping" }));
    await until(() => survivor.messages.some((m) => m.type === "pong"));

    // A non-Perch grouped clone and a manually linked window must survive.
    const shared = await create("shared");
    const clone = await run(
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}",
      "-s",
      "user-clone",
      "-t",
      shared.id,
    );
    await run("link-window", "-s", `${shared.id}:0`, "-t", other.id);
    const sharedViewer = connect(shared);
    const sharedViewerId = await ready(sharedViewer);
    expect((await kill(shared)).status).toBe(200);
    await until(() => sharedViewer.ws.readyState === WebSocket.CLOSED);
    await run("has-session", "-t", clone);
    expect(alive(shared.pid)).toBe(true);
    expect(
      await run("list-windows", "-t", other.id, "-F", "#{pane_pid}"),
    ).toContain(String(shared.pid));
    expect(await run("list-sessions", "-F", "#{session_id}")).not.toContain(
      sharedViewerId,
    );

    // Pause a kill after HTTP validation, then replace the target identity.
    const disappearing = await create("disappearing");
    await gate("kill-session -t", true);
    const racedKill = kill(disappearing);
    await blocked();
    await run("kill-session", "-t", disappearing.id);
    const replacement = await create("disappearing");
    await release();
    expect((await racedKill).ok).toBe(false);
    expect(alive(replacement.pid)).toBe(true);

    // A delayed open must revalidate in tmux, not attach from an old HTTP snapshot.
    await gate("new-session -d -P", true);
    const staleOpen = connect(replacement);
    await blocked();
    expect(
      (await kill({ ...replacement, created: replacement.created - 1 })).status,
    ).toBe(409);
    await run("kill-session", "-t", replacement.id);
    const latest = await create("disappearing");
    await release();
    await until(() => staleOpen.ws.readyState === WebSocket.CLOSED);
    expect(staleOpen.messages.some((m) => m.type === "ready")).toBe(false);
    expect(alive(latest.pid)).toBe(true);
    const state = (await (await fetch(origin + "/api/sessions")).json()) as {
      sessions: Session[];
    };
    expect(state.sessions.some((s) => s.id === latest.id)).toBe(true);
    expect(alive(other.pid)).toBe(true);
    expect(survivor.ws.readyState).toBe(WebSocket.OPEN);
    const names = (await run("list-sessions", "-F", "#{session_name}")).split(
      "\n",
    );
    expect(
      names.filter((n) => n.startsWith("__agent_watch_view_")).length,
    ).toBe(1);

    // Killing the final original must still report success when tmux exits.
    expect((await kill(latest)).status).toBe(200);
    const cloneCreated = Number(
      await run("display-message", "-p", "-t", clone, "#{session_created}"),
    );
    expect((await kill({ id: clone, created: cloneCreated })).status).toBe(200);
    expect((await kill(other)).status).toBe(200);
    await until(() => !alive(other.pid) && !alive(shared.pid));
    await until(() => survivor.ws.readyState === WebSocket.CLOSED);

    // A dedicated server restart reuses $0, but not its creation timestamp.
    // Exercise the final tmux guard with the SAME id, not merely a missing id.
    const old = await create("recycled");
    expect(old.id).toBe("$0");
    await gate("kill-session -t", true);
    const recycledKill = kill(old);
    await blocked();
    await run("kill-server");
    await until(() => Math.floor(Date.now() / 1000) > old.created);
    const recycled = await create("recycled");
    expect(recycled.id).toBe(old.id);
    expect(recycled.created).not.toBe(old.created);
    await release();
    expect((await recycledKill).status).toBe(409);
    expect(alive(recycled.pid)).toBe(true);

    await gate("new-session -d -P", true);
    const recycledOpen = connect(recycled);
    await blocked();
    await run("kill-server");
    await until(() => Math.floor(Date.now() / 1000) > recycled.created);
    const final = await create("recycled");
    expect(final.id).toBe(recycled.id);
    await release();
    await until(() => recycledOpen.ws.readyState === WebSocket.CLOSED);
    expect(recycledOpen.messages.some((m) => m.type === "ready")).toBe(false);
    expect(alive(final.pid)).toBe(true);
    expect(await run("list-sessions", "-F", "#{session_name}")).toBe(
      "recycled",
    );
  } finally {
    await rm(join(dir, "gate"), { force: true });
    for (const ws of sockets) ws.close();
    server?.kill();
    if (server) await server.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
