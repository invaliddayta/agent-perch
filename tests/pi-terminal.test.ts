import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piImageReference } from "../src/image-reference";

test("Pi file reference paste uses a disposable native tmux viewer, rejects changed agents and never submits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-pi-"));
  const socket = join(dir, "tmux.sock");
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["tmux", "-S", socket, "-f", "/dev/null", ...args], {
      env: { ...process.env, TMUX: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(p.stdout).text();
    if (await p.exited) throw new Error(await new Response(p.stderr).text());
    return text.trim();
  };
  let server: Bun.Subprocess | undefined;
  let ws: WebSocket | undefined;
  try {
    const fakeDir = join(
      dir,
      "node_modules/@earendil-works/pi-coding-agent/dist",
    );
    await mkdir(fakeDir, { recursive: true });
    const fake = join(fakeDir, "cli.js");
    const received = join(dir, "received");
    await writeFile(
      fake,
      `process.title = "pi"; process.stdin.setRawMode(true); process.stdout.write("\\x1b[?2004h"); process.stdin.on("data", async (data) => { await Bun.write(${JSON.stringify(received)}, (await Bun.file(${JSON.stringify(received)}).text().catch(() => "")) + data.toString()); }); setInterval(() => {}, 1000);`,
    );
    const id = await run(
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}",
      "-s",
      "pi-fixture",
      "-c",
      dir,
      process.execPath,
      fake,
    );
    const created = await run(
      "display-message",
      "-p",
      "-t",
      id,
      "#{session_created}",
    );
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port!;
    await probe.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    server = Bun.spawn([process.execPath, "--no-env-file", "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HOST: "127.0.0.1",
        PORT: String(port),
        TMUX_SOCKET: socket,
        STATE_DIR: join(dir, 'state with "quotes" $()'),
        PROJECTS_ROOT: dir,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        ready = (await fetch(origin + "/api/sessions")).ok;
        if (ready) break;
      } catch {}
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    const upload = await fetch(origin + "/api/images", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Agent-Watch": "1",
        "Content-Type": "image/png",
      },
      body: image,
    });
    expect(upload.status).toBe(201);
    const { path } = await upload.json();
    const Socket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    ws = new Socket(
      `${origin.replace("http:", "ws:")}/terminal?session=${encodeURIComponent(id)}&created=${created}&control=1`,
      { headers: { Origin: origin } },
    );
    const messages: any[] = [];
    ws.addEventListener("message", (event) =>
      messages.push(JSON.parse(String(event.data))),
    );
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await Bun.sleep(10);
      }
      throw new Error("Fixture timed out");
    };
    await until(() => messages.some((m) => m.type === "ready"));
    const paneId =
      messages.find((m) => m.type === "pane")?.paneId ||
      (await run("display-message", "-p", "-t", id, "#{pane_id}"));
    const paste = async (target: string, backend = "pi") => {
      const request = crypto.randomUUID();
      ws!.send(
        JSON.stringify({
          type: "paste",
          id: request,
          paneId: target,
          backend,
          submit: false,
          data: `\x1b[200~${piImageReference(path)}\x1b[201~`,
        }),
      );
      await until(() => messages.some((m) => m.id === request));
      return messages.find((m) => m.id === request);
    };
    expect((await paste("%999999")).error).toContain("changed");
    expect((await paste(paneId, "opencode")).error).toContain("changed");
    expect((await paste(paneId)).error).toBeUndefined();
    for (let i = 0; i < 100 && !(await Bun.file(received).exists()); i++)
      await Bun.sleep(10);
    const bytes = await Bun.file(received).text();
    expect(bytes).toContain(`\x1b[200~${piImageReference(path)}\x1b[201~`);
    expect(bytes).not.toMatch(/[\r\n]/);
    await run("respawn-pane", "-k", "-t", paneId, "sleep", "60");
    expect((await paste(paneId)).error).toContain("changed");
  } finally {
    ws?.close();
    server?.kill();
    if (server) await server.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
