import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("server owns attention startup, recovery, and dead-pane cleanup without browser polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-observers-"));
  const socket = join(dir, "tmux.sock");
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      ["tmux", "-S", socket, "-f", "/dev/null", ...args],
      {
        env: { ...process.env, TMUX: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(err);
    return out.trim();
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    throw new Error("Observer lifecycle timed out");
  };
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  await probe.stop(true);
  let server: Bun.Subprocess | undefined;
  try {
    const pane = await run(
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-P",
      "-F",
      "#{pane_id}",
      "/bin/sh",
    );
    const pid = await run("display-message", "-p", "-t", pane, "#{pane_pid}");
    const identity = crypto.randomUUID();
    for (const [key, value] of Object.entries({
      "@perch_run": identity,
      "@perch_backend": "codex",
      "@perch_pid": pid,
    }))
      await run("set-option", "-p", "-t", pane, key, value);
    server = Bun.spawn([process.execPath, "--no-env-file", "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        TMUX_SOCKET: socket,
        STATE_DIR: join(dir, "state"),
        DIST_DIR: join(dir, "dist"),
        PROJECTS_ROOT: dir,
        PUBLIC_ORIGIN: "",
        DEV_ORIGIN: "",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const clients = () =>
      run("list-clients", "-F", "#{client_control_mode} #{client_pid}");
    await until(async () => (await clients()).startsWith("1 "));
    const first = await clients();
    expect(first.split("\n")).toHaveLength(1);
    // No HTTP request or viewer has run. The existing tagged pane is observed on startup.
    await run(
      "send-keys",
      "-t",
      pane,
      "printf '\\033]9;fixture attention\\007'",
      "Enter",
    );
    await until(async () =>
      (
        await run("show-options", "-p", "-v", "-t", pane, "@perch_event").catch(
          () => "",
        )
      ).includes(":attention"),
    );
    const event = await run(
      "show-options",
      "-p",
      "-v",
      "-t",
      pane,
      "@perch_event",
    );
    expect(event).toStartWith(identity + ":");
    expect(event).not.toContain("fixture attention");
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`http://127.0.0.1:${port}/api/sessions`),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(await clients()).toBe(first);
    process.kill(Number(first.split(" ")[1]), "SIGTERM");
    await until(async () => {
      const next = await clients();
      return next.startsWith("1 ") && next !== first;
    });
    expect((await clients()).split("\n")).toHaveLength(1);
    expect(await run("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(
      pid,
    );
    await run("set-option", "-w", "-t", pane, "remain-on-exit", "on");
    await run("send-keys", "-t", pane, "exit", "Enter");
    await until(async () => (await clients()) === "");
    expect(await run("display-message", "-p", "-t", pane, "#{pane_dead}")).toBe(
      "1",
    );
  } finally {
    server?.kill();
    if (server) await server.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
