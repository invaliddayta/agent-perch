import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Snapshot } from "../src/types";
import { MODEL_PATH, RUNTIME_PATH } from "../src/speech-model";

test("all four CLIs launch without an OpenCode API or database; static files stay confined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-backends-"));
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
  let server: Bun.Subprocess | undefined;
  try {
    for (const path of [
      "home",
      "project with spaces",
      "dist",
      "codex",
      "dsh",
      "bin",
    ])
      await mkdir(join(dir, path));
    const monitorFailure = join(dir, "fail-monitor");
    const realTmux = Bun.which("tmux")!;
    await writeFile(
      join(dir, "bin", "tmux"),
      `#!/bin/sh\ncase " $* " in\n*" -C "*) if [ -f '${monitorFailure}' ]; then touch '${monitorFailure}.observed'; sleep 0.2; exit 1; fi;;\nesac\nexec '${realTmux}' "$@"\n`,
      { mode: 0o700 },
    );
    const fixture = join(dir, "fake agent");
    await writeFile(
      fixture,
      `#!${process.execPath}
// Simulated hooks only: no native agent completion or provider requests.
const args = process.argv.slice(2);
if (args[0] === "--config" && args[1] === "tui.notifications=true") {
  process.stdout.write("\\x1bPtmux;\\x1b\\x1b]9;PRIVATE_NOTIFICATION_PREVIEW\\x07\\x1b\\\\");
} else {
  const { report } = await import(${JSON.stringify(new URL("../integrations/report.mjs", import.meta.url).href)});
  await report("working");
  await report("ready");
}
console.log("PERCH_FIXTURE", JSON.stringify(args), process.cwd());
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    await writeFile(join(dir, "dist", "index.html"), "<h1>Private shell</h1>");
    for (const folder of ["assets", "models", MODEL_PATH, RUNTIME_PATH])
      await mkdir(join(dir, "dist", folder), { recursive: true });
    for (const file of [
      "/assets/voice.worker-fixture.js",
      `${RUNTIME_PATH}/moonshine.mjs`,
      `${RUNTIME_PATH}/index.js`,
    ])
      await writeFile(join(dir, "dist", file), "// runtime fixture");
    await writeFile(
      join(dir, "dist/models/ready.json"),
      '{"model":"old-whisper"}',
    );
    await writeFile(join(dir, "secret.txt"), "DO_NOT_SERVE");
    await symlink(join(dir, "secret.txt"), join(dir, "dist", "escape.txt"));
    // Start the isolated tmux server with an inert session; no user's tmux config.
    await run("new-session", "-d", "-s", "fixture", "sleep", "120");
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
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HOME: join(dir, "home"),
          TERM: "xterm-256color",
          PORT: String(port),
          TMUX_SOCKET: socket,
          PROJECTS_ROOT: join(dir, "home"),
          STATE_DIR: join(dir, "state"),
          DIST_DIR: join(dir, "dist"),
          OPENCODE_URL: "http://127.0.0.1:1",
          OPENCODE_DB_PATH: join(dir, "missing.db"),
          OPENCODE_BIN: fixture,
          PI_BIN: fixture,
          PI_CODING_AGENT_DIR: join(dir, "home"),
          CODEX_HOME: join(dir, "codex"),
          DSH_HOME: join(dir, "dsh"),
          CODEX_BIN: process.env.PERCH_TEST_CODEX_BIN || fixture,
          DEEPSEEK_BIN: process.env.PERCH_TEST_DEEPSEEK_BIN || fixture,
          // No credentials, user config, provider prompts, or billable turns in smoke tests.
          OPENAI_API_KEY: "",
          DEEPSEEK_API_KEY: "",
          DSH_TELEMETRY_DISABLED: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let snapshot: Snapshot | undefined;
    for (let i = 0; i < 80; i++) {
      try {
        snapshot = await (await fetch(origin + "/api/sessions")).json();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(snapshot?.backends.map((b) => b.available)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(snapshot?.voiceReady).toBe(false);
    await writeFile(join(dir, "dist", MODEL_PATH, "ready.json"), "{}");
    expect(
      (await (await fetch(origin + "/api/sessions")).json()).voiceReady,
    ).toBe(true);
    for (const path of [
      "/",
      `${RUNTIME_PATH}/index.js`,
      "/assets/voice.worker-fixture.js",
      `${RUNTIME_PATH}/moonshine.mjs`,
    ]) {
      const response = await fetch(origin + path);
      expect(response.ok).toBe(true);
      expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
        "same-origin",
      );
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
        "require-corp",
      );
      expect(
        response.headers
          .get("Content-Security-Policy")
          ?.includes("'unsafe-eval'"),
      ).toBe(path.includes("voice.worker-") || path.endsWith("moonshine.mjs"));
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "connect-src 'self'",
      );
    }
    const create = (body: unknown) =>
      fetch(origin + "/api/sessions", {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Agent-Watch": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    for (const backend of [
      "shell",
      "__proto__",
      "constructor",
      "toString",
      [],
      {},
    ])
      expect(
        (await create({ backend, name: "invalid", directory: dir })).status,
      ).toBe(400);
    for (const directory of ["", " ", "bad\npath", "~someone/path"])
      expect(
        (await create({ backend: "codex", directory, createDirectory: true }))
          .status,
      ).toBe(400);
    expect(
      (await create({ backend: "codex", directory: "missing" })).status,
    ).toBe(400);
    expect(
      (
        await create({
          backend: "codex",
          directory: "missing",
          createDirectory: "yes",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create({
          backend: "codex",
          name: "-invalid",
          directory: "invalid-name-dir",
          createDirectory: true,
        })
      ).status,
    ).toBe(400);
    expect(
      await stat(join(dir, "home", "invalid-name-dir")).catch(() => null),
    ).toBeNull();
    expect(
      (
        await create({
          backend: "deepseek",
          name: "bad-prompt",
          directory: dir,
          prompt: "must not submit",
        })
      ).status,
    ).toBe(400);
    if (!process.env.PERCH_TEST_CODEX_BIN) {
      const literalDirectory = join(dir, "literal-#{session_name}");
      const literalResponse = await create({
        backend: "codex",
        directory: literalDirectory,
        createDirectory: true,
      });
      expect(literalResponse.status).toBe(201);
      const literalSession = await literalResponse.json();
      expect(
        await run(
          "display-message",
          "-p",
          "-t",
          literalSession.id,
          "#{pane_current_path}",
        ),
      ).toBe(literalDirectory);
      const path = "new path/literal $(touch injected)";
      for (let i = 0; i < 2; i++) {
        const response = await create({
          backend: "codex",
          directory: path,
          createDirectory: true,
        });
        expect(response.status).toBe(201);
        const { id } = await response.json();
        const state = await run(
          "display-message",
          "-p",
          "-t",
          id,
          "#{session_name}|#{pane_current_path}",
        );
        expect(state).toBe(
          `literal---touch-injected-${i ? "-2" : ""}|${join(dir, "home", path)}`,
        );
      }
      expect((await stat(join(dir, "home", path))).isDirectory()).toBe(true);
      expect(await Bun.file(join(dir, "home", "injected")).exists()).toBe(
        false,
      );
      const homeSession = await create({
        backend: "codex",
        directory: "~/home-session",
        createDirectory: true,
      });
      expect(homeSession.status).toBe(201);
      expect(
        (await stat(join(dir, "home", "home-session"))).isDirectory(),
      ).toBe(true);
      const duplicate = await create({
        backend: "codex",
        name: "home-session",
        directory: "not-created",
        createDirectory: true,
      });
      expect(duplicate.status).toBe(400);
      expect(
        await stat(join(dir, "home", "not-created")).catch(() => null),
      ).toBeNull();
    }
    for (const backend of ["opencode", "codex", "pi", "deepseek"] as const) {
      const real =
        backend === "codex"
          ? process.env.PERCH_TEST_CODEX_BIN
          : backend === "deepseek"
            ? process.env.PERCH_TEST_DEEPSEEK_BIN
            : undefined;
      const prompt =
        backend !== "deepseek" && !real
          ? `--dangerously-bypass-approvals-and-sandbox $(touch ${join(dir, "injected")})`
          : "";
      const response = await create({
        backend,
        name: backend,
        directory: join(dir, "project with spaces"),
        prompt,
      });
      const result = await response.json();
      expect(response.status).toBe(201);
      expect(await run("show-environment", "-t", result.id, "HOME")).toBe(
        `HOME=${join(dir, "home")}`,
      );
      if (backend === "codex" || backend === "deepseek") {
        const variable = backend === "codex" ? "CODEX_HOME" : "DSH_HOME";
        expect(await run("show-environment", "-t", result.id, variable)).toBe(
          `${variable}=${join(dir, backend === "codex" ? "codex" : "dsh")}`,
        );
      }
      let output = "";
      const marker = real
        ? backend === "codex"
          ? /Welcome to Codex|OpenAI Codex|Sign in|trust this|Codex/
          : /main-session-/
        : /PERCH_FIXTURE/;
      for (let i = 0; i < 200; i++) {
        output = await run("capture-pane", "-p", "-t", result.id);
        if (marker.test(output)) break;
        await Bun.sleep(100);
      }
      expect(output).toMatch(marker);
      if (!real) {
        let pane: Snapshot["sessions"][number]["panes"][number] | undefined;
        for (let i = 0; i < 50; i++) {
          const response = await fetch(origin + "/api/sessions");
          expect(response.status).toBe(200);
          const state = (await response.json()) as Snapshot;
          pane = state.sessions.find((session) => session.id === result.id)
            ?.panes[0];
          if (pane?.status?.event) break;
          await Bun.sleep(50);
        }
        expect(pane?.status).toEqual({
          run: expect.any(String),
          backend,
          state: backend === "codex" ? "attention" : "ready",
          event: {
            id: expect.any(String),
            state: backend === "codex" ? "attention" : "ready",
          },
        });
        expect(JSON.stringify(pane?.status)).not.toContain(
          "PRIVATE_NOTIFICATION_PREVIEW",
        );
        expect(JSON.stringify(pane?.status)).not.toContain(
          prompt || "PRIVATE_NOTIFICATION_PREVIEW",
        );
        // No websocket/browser viewer has ever attached. OSC9 was emitted once,
        // immediately at CLI startup, so this also exercises the launch gate.
        expect(
          await run("list-sessions", "-F", "#{session_name}"),
        ).not.toContain("__agent_watch_view_");
      }
      if (prompt) {
        const captured = await run("capture-pane", "-p", "-J", "-t", result.id);
        expect(captured).toContain(
          JSON.stringify(
            backend === "opencode"
              ? [join(dir, "project with spaces"), `--prompt=${prompt}`]
              : backend === "pi"
                ? [prompt]
                : [
                    "--config",
                    "tui.notifications=true",
                    "--config",
                    'tui.notification_method="osc9"',
                    "--config",
                    'tui.notification_condition="always"',
                    "--cd",
                    join(dir, "project with spaces"),
                    "--",
                    prompt,
                  ],
          ),
        );
        expect(await Bun.file(join(dir, "injected")).exists()).toBe(false);
      }
      expect(
        await run(
          "display-message",
          "-p",
          "-t",
          result.id,
          "#{pane_current_path}",
        ),
      ).toBe(join(dir, "project with spaces"));
      const action = await fetch(
        origin + `/api/sessions/${encodeURIComponent(result.id)}/action`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            "X-Agent-Watch": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "compact", id: crypto.randomUUID() }),
        },
      );
      expect(action.status).toBe(404);
      if (real) {
        const state = (await (
          await fetch(origin + "/api/sessions")
        ).json()) as Snapshot;
        expect(
          state.sessions.find((s) => s.id === result.id)?.panes[0].backend,
        ).toBe(backend);
        if (backend === "deepseek") {
          await run("send-keys", "-t", result.id, "-l", "/model");
          await run("send-keys", "-t", result.id, "Enter");
          for (let i = 0; i < 60; i++) {
            output = await run("capture-pane", "-p", "-t", result.id);
            if (output.includes("Select model")) break;
            await Bun.sleep(100);
          }
          expect(output).toContain("Select model");
        }
      }
    }
    // The Nix wrapper pins tmux ahead of PATH; fault injection is source-only.
    if (
      !process.env.PERCH_TEST_PACKAGE_BIN &&
      !process.env.PERCH_TEST_CODEX_BIN &&
      !process.env.PERCH_TEST_DEEPSEEK_BIN
    ) {
      const original = (await (
        await fetch(origin + "/api/sessions")
      ).json()) as Snapshot;
      await writeFile(monitorFailure, "fail readiness, not tmux or the agent");
      const failingLaunch = create({
        backend: "codex",
        name: "observer-fails",
        directory: dir,
      });
      await Bun.sleep(100);
      expect((await fetch(origin + "/api/sessions")).status).toBe(200);
      const failedObserver = await failingLaunch;
      expect(failedObserver.status).toBe(201);
      const failedObserverId = (await failedObserver.json()).id;
      expect(await Bun.file(monitorFailure + ".observed").exists()).toBe(true);
      const unrelated = await create({
        backend: "opencode",
        name: "unrelated-success",
        directory: dir,
      });
      expect(unrelated.status).toBe(201);
      const unrelatedId = (await unrelated.json()).id;
      const response = await fetch(origin + "/api/sessions");
      expect(response.status).toBe(200);
      const state = (await response.json()) as Snapshot;
      for (const id of [
        ...original.sessions.map((s) => s.id),
        failedObserverId,
        unrelatedId,
      ]) {
        expect(
          state.sessions.some((s) => s.id === id && !s.panes[0]?.dead),
        ).toBe(true);
      }
      for (const id of [failedObserverId, unrelatedId]) {
        let output = "";
        for (let i = 0; i < 50; i++) {
          output = await run("capture-pane", "-p", "-t", id);
          if (output.includes("PERCH_FIXTURE")) break;
          await Bun.sleep(50);
        }
        expect(output).toContain("PERCH_FIXTURE");
      }
    }
    expect((await fetch(origin + "/")).status).toBe(200);
    expect((await fetch(origin + "/api/projects")).status).toBe(404);
    // Only a launch-scoped DSH plugin patch is written, never session histories.
    expect(
      await Bun.file(join(dir, "state/integrations/deepseek.json")).json(),
    ).toEqual([
      {
        insert: [
          {
            id: "perch-events",
            name: process.env.PERCH_TEST_PACKAGE_BIN
              ? expect.stringMatching(/\/integrations\/deepseek\.mjs$/)
              : join(import.meta.dir, "../integrations/deepseek.mjs"),
          },
        ],
      },
    ]);
    expect(await stat(join(dir, "missing.db")).catch(() => null)).toBeNull();
    for (const path of [
      "/escape.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%252e%252e%252fsecret.txt",
    ])
      expect((await fetch(origin + path)).status).toBe(404);
    expect(
      (
        await fetch(origin + "/terminal", {
          headers: { Upgrade: "websocket", Connection: "Upgrade" },
        })
      ).status,
    ).toBe(403);
  } finally {
    server?.kill();
    if (server) await server.exited;
    await run("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
