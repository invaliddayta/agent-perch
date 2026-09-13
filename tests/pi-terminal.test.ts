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
    server = Bun.spawn(
      process.env.PERCH_TEST_PACKAGE_BIN
        ? [process.env.PERCH_TEST_PACKAGE_BIN]
        : [process.execPath, "--no-env-file", "server/index.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          HOST: "127.0.0.1",
          PORT: String(port),
          TMUX_SOCKET: socket,
          ...(process.env.PERCH_TEST_PACKAGE_BIN
            ? { XDG_STATE_HOME: join(dir, 'state with "quotes" $()') }
            : { STATE_DIR: join(dir, 'state with "quotes" $()') }),
          PROJECTS_ROOT: dir,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        ready = (await fetch(origin + "/api/sessions")).ok;
        if (ready) break;
      } catch {}
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    if (process.env.PERCH_TEST_PACKAGE_BIN) {
      const response = await fetch(origin + "/");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
      expect(assets.length).toBeGreaterThan(0);
      for (const [, path] of assets) {
        const asset = await fetch(origin + path);
        expect(asset.status).toBe(200);
        expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    }
    const upload = async (release = Promise.resolve()) => {
      const response = await fetch(origin + "/api/images", {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Agent-Watch": "1",
          "Content-Type": "image/png",
        },
        body: new ReadableStream({
          async start(controller) {
            await release;
            controller.enqueue(Buffer.from("89504e470d0a1a0a", "hex"));
            controller.close();
          },
        }),
      });
      expect(response.status).toBe(201);
      const { path } = await response.json();
      if (process.env.PERCH_TEST_PACKAGE_BIN)
        expect(path).toStartWith(
          join(dir, 'state with "quotes" $()', "agent-perch", "images"),
        );
      return path as string;
    };
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
    const capture = async (target = paneId) => {
      const request = crypto.randomUUID();
      ws!.send(
        JSON.stringify({
          type: "capture-paste-target",
          id: request,
          paneId: target,
          backend: "pi",
        }),
      );
      await until(() => messages.some((m) => m.id === request));
      const ack = messages.find((m) => m.id === request);
      return { id: request, error: ack.error };
    };
    expect((await capture("%999999")).error).toContain("changed");
    let destination = await capture();
    expect(destination.error).toBeUndefined();
    let path = await upload();
    const paste = async (
      target: string,
      backend = "pi",
      targetId: string | undefined = destination.id,
    ) => {
      const request = crypto.randomUUID();
      ws!.send(
        JSON.stringify({
          type: "paste",
          id: request,
          paneId: target,
          backend,
          targetId,
          submit: false,
          data: `\x1b[200~${piImageReference(path)}\x1b[201~`,
        }),
      );
      await until(() => messages.some((m) => m.id === request));
      return messages.find((m) => m.id === request);
    };
    expect((await paste("%999999")).error).toContain("changed");
    expect((await paste(paneId, "opencode")).error).toContain("changed");
    expect((await paste(paneId, "pi", "missing-target-0000")).error).toContain(
      "changed",
    );
    expect((await paste(paneId)).error).toBeUndefined();
    for (let i = 0; i < 100 && !(await Bun.file(received).exists()); i++)
      await Bun.sleep(10);
    const bytes = await Bun.file(received).text();
    expect(bytes).toContain(`\x1b[200~${piImageReference(path)}\x1b[201~`);
    expect(bytes).not.toMatch(/[\r\n]/);
    await rm(received);
    // Hold upload completion after capture, replacing Pi with Pi in the same pane.
    const held = Promise.withResolvers<void>();
    const heldUpload = upload(held.promise);
    await run("respawn-pane", "-k", "-t", paneId, process.execPath, fake);
    await Bun.sleep(100);
    held.resolve();
    path = await heldUpload;
    expect((await paste(paneId)).error).toContain("changed");
    await Bun.sleep(100);
    expect(await Bun.file(received).exists()).toBe(false);
    destination = await capture();
    expect(destination.error).toBeUndefined();
    expect((await paste(paneId)).error).toBeUndefined();
    await until(() => Bun.file(received).size > 0);
    expect(await Bun.file(received).text()).toBe(
      `\x1b[200~${piImageReference(path)}\x1b[201~`,
    );

    // A persistent Bun wrapper must not hide replacement of its actual Pi child.
    const wrapper = join(dir, "wrapper.js");
    await writeFile(
      wrapper,
      `const start = () => Bun.spawn([process.execPath, ${JSON.stringify(fake)}], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); let child = start(); process.on("SIGUSR1", async () => { child.kill(); await child.exited; child = start(); }); setInterval(() => {}, 1000);`,
    );
    await run("respawn-pane", "-k", "-t", paneId, process.execPath, wrapper);
    await Bun.sleep(150);
    destination = await capture();
    expect(destination.error).toBeUndefined();
    await rm(received);
    const wrapperPid = Number(
      await run("display-message", "-p", "-t", paneId, "#{pane_pid}"),
    );
    process.kill(wrapperPid, "SIGUSR1");
    await Bun.sleep(150);
    expect(
      Number(await run("display-message", "-p", "-t", paneId, "#{pane_pid}")),
    ).toBe(wrapperPid);
    expect((await paste(paneId)).error).toContain("changed");
    await Bun.sleep(100);
    expect(await Bun.file(received).exists()).toBe(false);
    destination = await capture();
    expect(destination.error).toBeUndefined();
    expect((await paste(paneId)).error).toBeUndefined();
    await until(() => Bun.file(received).size > 0);
    expect(await Bun.file(received).text()).toBe(
      `\x1b[200~${piImageReference(path)}\x1b[201~`,
    );
    await rm(received);
    const previousSocket = ws;
    previousSocket.close();
    await until(() => previousSocket.readyState === WebSocket.CLOSED);
    messages.length = 0;
    ws = new Socket(previousSocket.url, { headers: { Origin: origin } });
    ws.addEventListener("message", (event) =>
      messages.push(JSON.parse(String(event.data))),
    );
    await until(() => messages.some((m) => m.type === "ready"));
    expect((await paste(paneId)).error).toContain("changed");
    await Bun.sleep(100);
    expect(await Bun.file(received).exists()).toBe(false);
    destination = await capture();
    expect(destination.error).toBeUndefined();
    expect((await paste(paneId)).error).toBeUndefined();
    await until(() => Bun.file(received).size > 0);
    expect(await Bun.file(received).text()).toBe(
      `\x1b[200~${piImageReference(path)}\x1b[201~`,
    );
    await run("respawn-pane", "-k", "-t", paneId, "sleep", "60");
    expect((await paste(paneId)).error).toContain("changed");
    expect((await capture()).error).toContain("changed");
  } finally {
    ws?.close();
    server?.kill();
    if (server) await server.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
