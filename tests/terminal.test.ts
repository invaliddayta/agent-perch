import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("isolated tmux: watch rejects input, control works, viewer cleanup preserves original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-pty-"));
  const socket = join(dir, "tmux.sock");
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      ["tmux", "-S", socket, "-f", "/dev/null", ...args],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: "" } },
    );
    const output = await new Response(child.stdout).text();
    if (await child.exited)
      throw new Error(await new Response(child.stderr).text());
    return output.trim();
  };
  const session = await run(
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    "test",
    "sh",
    "-c",
    'printf "TEST_READY\n"; exec /bin/sh',
  );
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  await probe.stop(true);
  const created = await run(
    "display-message",
    "-p",
    "-t",
    session,
    "#{session_created}",
  );
  const origin = `http://127.0.0.1:${port}`;
  const state = join(dir, "state");
  await mkdir(state);
  const bin = join(dir, "bin");
  const queryLog = join(dir, "queries");
  await mkdir(bin);
  await writeFile(queryLog, "");
  await writeFile(
    join(bin, "tmux"),
    `#!/bin/sh\nfor arg do\n  if [ "$arg" = display-message ]; then printf 'query\\n' >> '${queryLog}'; fi\ndone\nexec '${Bun.which("tmux")!}' "$@"\n`,
    { mode: 0o700 },
  );
  const legacy =
    "{invalid legacy metadata: must not be parsed, replayed or rewritten}";
  for (const file of ["sessions.json", "existing-operations.json"])
    await writeFile(join(state, file), legacy);
  const proc = Bun.spawn(
    [process.execPath, "--no-env-file", "server/index.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PORT: String(port),
        TMUX_SOCKET: socket,
        STATE_DIR: join(dir, "state"),
        OPENCODE_URL: "http://127.0.0.1:1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_DB_PATH: join(dir, "missing.db"),
        PROJECTS_ROOT: dir,
        PUBLIC_ORIGIN: "",
        DEV_ORIGIN: "",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const sockets: WebSocket[] = [];
  const metadata = new Map<WebSocket, { paneId: string; viewerId: string }>();
  const paneEvents = new Map<WebSocket, string[]>();
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await Bun.sleep(10);
    }
    throw new Error("Native pane event missing");
  };
  try {
    let response: Response | undefined;
    for (let i = 0; i < 60; i++) {
      try {
        response = await fetch(origin + "/api/sessions");
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(response?.ok).toBe(true);
    for (const file of ["sessions.json", "existing-operations.json"])
      expect(await Bun.file(join(state, file)).text()).toBe(legacy);
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    expect(
      (
        await fetch(origin + "/api/images", {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: image,
        })
      ).status,
    ).toBe(403);
    const uploaded = await fetch(origin + "/api/images", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Agent-Watch": "1",
        "Content-Type": "image/png",
      },
      body: image,
    });
    expect(uploaded.status).toBe(201);
    const { path } = await uploaded.json();
    expect(path.startsWith(join(dir, "state", "images"))).toBe(true);
    expect(
      (await fetch(origin + "/images/" + path.split("/").at(-1))).status,
    ).toBe(404);
    expect(
      (
        await (
          await fetch(origin + "/api/sessions", {
            headers: { Origin: "https://attacker.invalid" },
          })
        ).json()
      ).error,
    ).toMatch(/^Origin not allowed \(origin; reference [a-f0-9]{8}\)$/);
    expect(
      (
        await fetch(origin + "/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    async function connect(control: boolean) {
      // DOM typings omit Bun's documented client-header overload.
      const Socket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const ws = new Socket(
        `ws://127.0.0.1:${port}/terminal?session=${encodeURIComponent(session)}&created=${created}&control=${control ? 1 : 0}&fit=1`,
        { headers: { Origin: origin } },
      );
      sockets.push(ws);
      paneEvents.set(ws, []);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("WebSocket ready timeout")),
          5000,
        );
        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === "ready" || msg.type === "pane") {
            metadata.set(ws, { paneId: msg.paneId, viewerId: msg.viewerId });
            paneEvents.get(ws)!.push(msg.paneId);
          }
          if (msg.type === "ready") {
            clearTimeout(timer);
            resolve();
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("WebSocket error"));
        });
      });
      return ws;
    }
    async function paste(
      ws: WebSocket,
      data: string,
      paneId = metadata.get(ws)!.paneId,
      opencodeOnly = false,
    ) {
      const id = crypto.randomUUID();
      return await new Promise<{ error?: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Missing paste acknowledgment")),
          5000,
        );
        const listener = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "input-ack" && msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener);
            resolve(msg);
          }
        };
        ws.addEventListener("message", listener);
        ws.send(
          JSON.stringify({
            type: "paste",
            id,
            data,
            paneId,
            submit: false,
            opencodeOnly,
          }),
        );
      });
    }
    const watch = await connect(false);
    watch.send(
      JSON.stringify({ type: "input", data: "printf WATCH_UNSAFE\\n\r" }),
    );
    await Bun.sleep(150);
    expect(await run("capture-pane", "-p", "-t", session)).not.toContain(
      "WATCH_UNSAFE",
    );
    expect((await paste(watch, "printf WATCH_PASTE_UNSAFE")).error).toContain(
      "read-only",
    );
    watch.close();
    await Bun.sleep(150);
    const control = await connect(true);
    const originalPane = metadata.get(control)!.paneId;
    const originalPID = await run(
      "display-message",
      "-p",
      "-t",
      originalPane,
      "#{pane_pid}",
    );
    const idleQueries = await Bun.file(queryLog).text();
    await Bun.sleep(1250);
    expect(await Bun.file(queryLog).text()).toBe(idleQueries);
    const copied = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Clipboard event missing")),
        5000,
      );
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "clipboard") {
          clearTimeout(timer);
          control.removeEventListener("message", listener);
          resolve(message.text);
        }
      };
      control.addEventListener("message", listener);
    });
    await run(
      "send-keys",
      "-t",
      session,
      `printf '\\033]52;c;${Buffer.from("COPY_FROM_TUI").toString("base64")}\\007'`,
      "Enter",
    );
    expect(await copied).toBe("COPY_FROM_TUI");
    expect(await run("show-options", "-sv", "set-clipboard")).toBe("external");
    expect(
      await run(
        "show-options",
        "-v",
        "-t",
        metadata.get(control)!.viewerId,
        "mouse",
      ),
    ).toBe("on");
    expect(await run("show-options", "-gv", "mouse")).toBe("off");
    expect(await run("show-options", "-v", "-t", session, "mouse")).toBe("");
    expect(
      (
        await paste(
          control,
          "NEVER_TO_SHELL",
          metadata.get(control)!.paneId,
          true,
        )
      ).error,
    ).toContain("no longer OpenCode");
    control.send(
      JSON.stringify({ type: "input", data: "printf 'CONTROL_OK\\n'\r" }),
    );
    await Bun.sleep(150);
    expect(await run("capture-pane", "-p", "-t", session)).toContain(
      "CONTROL_OK",
    );
    expect(
      (
        await paste(
          control,
          `printf 'PASTE_ACK_OK\\n' > '${dir}/paste-delivered'`,
        )
      ).error,
    ).toBeUndefined();
    await Bun.sleep(100);
    expect(await Bun.file(join(dir, "paste-delivered")).exists()).toBe(false);
    control.send(JSON.stringify({ type: "input", data: "\r" }));
    await Bun.sleep(100);
    expect(await Bun.file(join(dir, "paste-delivered")).text()).toBe(
      "PASTE_ACK_OK\n",
    );
    const rejectedSubmit = await connect(true);
    const closed = new Promise<number>((resolve) =>
      rejectedSubmit.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    rejectedSubmit.send(
      JSON.stringify({
        type: "paste",
        id: crypto.randomUUID(),
        submit: true,
        data: `touch '${dir}/submit-rejected'`,
        paneId: metadata.get(rejectedSubmit)!.paneId,
      }),
    );
    expect(await closed).toBe(1008);
    expect(await Bun.file(join(dir, "submit-rejected")).exists()).toBe(false);
    expect(await run("capture-pane", "-p", "-t", session)).not.toContain(
      "submit-rejected",
    );
    control.send(
      JSON.stringify({ type: "response", data: "printf RESPONSE_UNSAFE\r" }),
    );
    await Bun.sleep(100);
    expect(await run("capture-pane", "-p", "-t", session)).not.toContain(
      "RESPONSE_UNSAFE",
    );
    control.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await Bun.sleep(200);
    expect(
      await run(
        "display-message",
        "-p",
        "-t",
        session,
        "#{pane_width}x#{pane_height}",
      ),
    ).toBe("120x40");
    await paste(control, "seq 1 200");
    control.send(JSON.stringify({ type: "input", data: "\r" }));
    await Bun.sleep(100);
    control.send(JSON.stringify({ type: "input", data: "\x1b[<64;5;5M" }));
    await Bun.sleep(150);
    expect(
      await run("display-message", "-p", "-t", session, "#{pane_in_mode}"),
    ).toBe("1");
    await run("send-keys", "-t", metadata.get(control)!.paneId, "-X", "cancel");
    const newPane = await run(
      "new-window",
      "-t",
      session,
      "-P",
      "-F",
      "#{pane_id}",
      "/bin/sh",
    );
    const hiddenCopies: string[] = [];
    const onHiddenCopy = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "clipboard") hiddenCopies.push(message.text);
    };
    control.addEventListener("message", onHiddenCopy);
    await run(
      "send-keys",
      "-t",
      newPane,
      `printf '\\033]52;c;${Buffer.from("HIDDEN_COPY").toString("base64")}\\007'`,
      "Enter",
    );
    await Bun.sleep(150);
    expect(hiddenCopies).toEqual([]);
    control.removeEventListener("message", onHiddenCopy);
    expect(
      (await paste(control, "printf WRONG_PANE", newPane)).error,
    ).toContain("changed");
    const independent = await connect(true);
    const viewer = metadata.get(control)!.viewerId;
    const firstWindow = await run(
      "display-message",
      "-p",
      "-t",
      originalPane,
      "#{window_id}",
    );
    const nextWindow = await run(
      "display-message",
      "-p",
      "-t",
      newPane,
      "#{window_id}",
    );
    await run(
      "select-window",
      "-t",
      `${metadata.get(independent)!.viewerId}:${nextWindow}`,
    );
    await until(() => metadata.get(independent)!.paneId === newPane);
    const selectWindow = (id: string) =>
      run("select-window", "-t", `${viewer}:${id}`);
    await selectWindow(nextWindow);
    await until(() => metadata.get(control)!.paneId === newPane);
    paneEvents.get(control)!.length = 0;
    await run(
      "select-window",
      "-t",
      `${viewer}:${firstWindow}`,
      ";",
      "select-window",
      "-t",
      `${viewer}:${nextWindow}`,
    );
    await until(
      () =>
        paneEvents.get(control)!.includes("") &&
        metadata.get(control)!.paneId === newPane,
    );
    expect(paneEvents.get(control)).toContain("");

    await selectWindow(firstWindow);
    await until(() => metadata.get(control)!.paneId === originalPane);
    paneEvents.get(independent)!.length = 0;
    const split = await run(
      "split-window",
      "-d",
      "-t",
      originalPane,
      "-P",
      "-F",
      "#{pane_id}",
      "/bin/sh",
    );
    paneEvents.get(control)!.length = 0;
    await run(
      "select-pane",
      "-t",
      split,
      ";",
      "select-pane",
      "-t",
      originalPane,
    );
    await until(
      () =>
        paneEvents.get(control)!.includes("") &&
        metadata.get(control)!.paneId === originalPane,
    );
    expect(paneEvents.get(independent)).toEqual([]);
    expect(metadata.get(independent)!.paneId).toBe(newPane);
    paneEvents.get(control)!.length = 0;
    await run(
      "send-keys",
      "-t",
      originalPane,
      `printf '%s\\n' '%session-window-changed ${viewer} ${nextWindow}' '%window-pane-changed ${firstWindow} ${split}'`,
      "Enter",
    );
    await Bun.sleep(100);
    expect(paneEvents.get(control)).toEqual([]);
    const rejected = await fetch(
      origin + `/api/sessions/${encodeURIComponent(session)}/action`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Agent-Watch": "1",
        },
        body: JSON.stringify({
          action: "compact",
          id: crypto.randomUUID(),
          paneId: newPane,
          viewerId: metadata.get(control)!.viewerId,
          created: Number(created),
        }),
      },
    );
    expect(rejected.status).toBe(404);
    const observer = (
      await run(
        "list-clients",
        "-t",
        viewer,
        "-F",
        "#{client_control_mode} #{client_pid}",
      )
    )
      .split("\n")
      .find((line) => line.startsWith("1 "))!;
    expect(observer).toBeDefined();
    const observerClosed = new Promise<number>((resolve) =>
      control.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    process.kill(Number(observer.split(" ")[1]), "SIGTERM");
    expect(await observerClosed).toBe(1011);
    expect(independent.readyState).toBe(WebSocket.OPEN);
    expect(
      await run("display-message", "-p", "-t", originalPane, "#{pane_pid}"),
    ).toBe(originalPID);
    independent.close();
    await Bun.sleep(250);
    expect(await run("list-sessions", "-F", "#{session_name}")).toBe("test");
    await run("has-session", "-t", session);
  } finally {
    for (const ws of sockets) ws.close();
    proc.kill();
    await proc.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
