import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusLaunch } from "../server/agent-status";
import { report } from "../integrations/report.mjs";
import { paneStatus, unreadEvents } from "../src/status";
import type { Session } from "../src/types";

test("status launch preserves inline JSONC and plugins without modifying private config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-status-config-"));
  try {
    const home = join(dir, "home");
    await mkdir(home);
    const privateConfig = join(home, "opencode.jsonc");
    const original =
      '{ // private config\n "model": "private/model", "plugin": ["existing-plugin"], }';
    await writeFile(privateConfig, original);
    const env = {
      HOME: home,
      OPENCODE_CONFIG: privateConfig,
      OPENCODE_CONFIG_CONTENT: original,
    };
    const before = { ...env };
    const launch = await statusLaunch("opencode", join(dir, "state"), env);
    expect(launch.args).toEqual([]);
    expect(launch.environment).toHaveLength(1);
    expect(launch.environment[0]).toStartWith("OPENCODE_CONFIG_CONTENT=");
    expect(
      JSON.parse(launch.environment[0]!.split("=").slice(1).join("=")),
    ).toEqual({
      model: "private/model",
      plugin: [
        "existing-plugin",
        new URL("../integrations/opencode.mjs", import.meta.url).href,
      ],
    });
    expect(env).toEqual(before);
    expect(await readFile(privateConfig, "utf8")).toBe(original);
    expect(await readdir(home)).toEqual(["opencode.jsonc"]);
    expect(await stat(join(dir, "state")).catch(() => null)).toBeNull();
    for (const value of ["null", "[]", '"text"', '{"plugin":"bad"}'])
      await expect(
        statusLaunch("opencode", dir, { OPENCODE_CONFIG_CONTENT: value }),
      ).rejects.toThrow();
    expect(await statusLaunch("codex", dir, {})).toEqual({
      args: [
        "--config",
        "tui.notifications=true",
        "--config",
        'tui.notification_method="osc9"',
        "--config",
        'tui.notification_condition="always"',
      ],
      environment: [],
    });
    const dsh = await statusLaunch(
      "deepseek",
      join(dir, "state with spaces"),
      {},
    );
    const patch = join(
      dir,
      "state with spaces",
      "integrations",
      "deepseek.json",
    );
    expect(dsh).toEqual({ args: ["--patch", patch], environment: [] });
    // JSON is also valid YAML, with only the observer plugin insertion.
    expect(JSON.parse(await readFile(patch, "utf8"))).toEqual([
      {
        insert: [
          {
            id: "perch-events",
            name: join(import.meta.dir, "../integrations/deepseek.mjs"),
          },
        ],
      },
    ]);
    expect((await stat(patch)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["opencode.jsonc"]);
    expect(await readFile(privateConfig, "utf8")).toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pane status validates identity and coarse values; unread events survive subsequent work", () => {
  const run = crypto.randomUUID();
  const event = crypto.randomUUID();
  const status = paneStatus(
    run,
    "codex",
    "12",
    "12",
    `${run}:working`,
    `${run}:${event}:ready`,
  )!;
  expect(status).toEqual({
    run,
    backend: "codex",
    state: "working",
    event: { id: event, state: "ready" },
  });
  expect(paneStatus(run, "codex", "11", "12", "", "")).toBeUndefined();
  expect(paneStatus("bad", "codex", "12", "12", "", "")).toBeUndefined();
  expect(paneStatus(run, "shell", "12", "12", "", "")).toBeUndefined();
  for (const value of [
    "private text",
    `${crypto.randomUUID()}:ready`,
    `${run}:ready:private text`,
  ])
    expect(paneStatus(run, "codex", "12", "12", value, "")?.state).toBe(
      "unknown",
    );
  for (const value of [
    `${crypto.randomUUID()}:${event}:ready`,
    `${run}:bad:ready`,
    `${run}:${event}:working`,
    `${run}:${event}:ready:private text`,
  ])
    expect(
      paneStatus(run, "codex", "12", "12", "", value)?.event,
    ).toBeUndefined();
  const session: Session = {
    id: "$1",
    name: "fixture",
    created: 10,
    attached: 0,
    panes: [
      {
        id: "%1",
        windowId: "@1",
        windowName: "fixture",
        index: "0",
        command: "fixture",
        cwd: "/tmp",
        active: true,
        dead: false,
        status,
      },
    ],
  };
  const key = `$1@10:%1:${run}`;
  expect(unreadEvents([session], {}).map((e) => [e.key, e.event])).toEqual([
    [key, status.event!],
  ]);
  expect(unreadEvents([session], { [key]: event })).toEqual([]);
  expect(unreadEvents([session], { [key]: crypto.randomUUID() })).toHaveLength(
    1,
  );
  expect(
    unreadEvents([{ ...session, created: 11 }], { [key]: event }),
  ).toHaveLength(1);
  expect(
    unreadEvents(
      [{ ...session, panes: [{ ...session.panes[0]!, id: "%2" }] }],
      { [key]: event },
    ),
  ).toHaveLength(1);
  expect(
    unreadEvents(
      [
        {
          ...session,
          panes: [
            {
              ...session.panes[0]!,
              status: { ...status, run: crypto.randomUUID() },
            },
          ],
        },
      ],
      { [key]: event },
    ),
  ).toHaveLength(1);
  expect(
    unreadEvents(
      [{ ...session, panes: [{ ...session.panes[0]!, dead: true }] }],
      {},
    ),
  ).toEqual([]);
});

test("report targets an exact run and live PID, latches events, and never stores private payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-report-"));
  const socket = join(dir, "tmux.sock");
  const executable = Bun.which("tmux")!;
  const env = {
    HOME: dir,
    PATH: process.env.PATH,
    TMUX: "",
    PERCH_TMUX: executable,
    PERCH_TMUX_SOCKET: socket,
  };
  const tmux = async (...args: string[]) => {
    const proc = Bun.spawn(
      [executable, "-S", socket, "-f", "/dev/null", ...args],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code) throw Error(err);
    return out.trim();
  };
  try {
    const pane = await tmux(
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "report",
      "sleep",
      "120",
    );
    const other = await tmux(
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      pane,
      "sleep",
      "120",
    );
    const run = crypto.randomUUID();
    for (const target of [pane, other]) {
      await tmux(
        "set-option",
        "-p",
        "-t",
        target,
        "@perch_run",
        target === pane ? run : crypto.randomUUID(),
      );
      await tmux(
        "set-option",
        "-p",
        "-t",
        target,
        "@perch_pid",
        await tmux("display-message", "-p", "-t", target, "#{pane_pid}"),
      );
    }
    const reporter = {
      ...env,
      PERCH_RUN_ID: run,
      TMUX_PANE: pane,
      PRIVATE_PROMPT: "DO_NOT_STORE_PRIVATE_DATA",
    };
    const values = (target = pane) =>
      tmux(
        "display-message",
        "-p",
        "-t",
        target,
        "#{@perch_state}|#{@perch_event}",
      );
    await Promise.all([
      report("working", reporter),
      report("ready", reporter),
      report("working", reporter),
    ]);
    const latched = await values();
    expect(latched).toMatch(
      new RegExp(`^${run}:working\\|${run}:[a-f0-9-]{36}:ready$`),
    );
    await report("idle", reporter);
    expect((await values()).split("|")[1]).toBe(latched.split("|")[1]);
    for (const state of ["attention", "error", "ready"] as const) {
      await report(state, reporter);
      expect(await values()).toMatch(
        new RegExp(`^${run}:${state}\\|${run}:[a-f0-9-]{36}:${state}$`),
      );
    }
    const valid = await values();
    // @ts-expect-error Native hooks are JavaScript and can supply invalid states.
    await report("ready:DO_NOT_STORE_PRIVATE_DATA", reporter);
    await report("error", { ...reporter, PERCH_RUN_ID: crypto.randomUUID() });
    await report("error", { ...reporter, TMUX_PANE: other });
    await report("error", {
      ...reporter,
      TMUX_PANE: `${pane}; set-option -p -t ${other} @perch_state injected`,
    });
    expect(await values()).toBe(valid);
    expect(await values(other)).toBe("|");
    const oldPid = await tmux(
      "display-message",
      "-p",
      "-t",
      pane,
      "#{pane_pid}",
    );
    await tmux("respawn-pane", "-k", "-t", pane, "sleep", "120");
    expect(
      await tmux("display-message", "-p", "-t", pane, "#{pane_pid}"),
    ).not.toBe(oldPid);
    await report("error", reporter);
    expect(await values()).toBe(valid);
    expect(await values(other)).toBe("|");
    expect(await tmux("show-options", "-p", "-t", pane)).not.toContain(
      "DO_NOT_STORE_PRIVATE_DATA",
    );
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test.each(["crash", "never-release"])(
  "launch gate %s still starts the inert agent within five seconds",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "perch-gate-"));
    let child: Bun.Subprocess | undefined;
    try {
      const waiter = join(dir, "tmux-fixture");
      await writeFile(
        waiter,
        `#!${process.execPath}\n${mode === "crash" ? "process.exit(1);" : "setInterval(() => {}, 1000);"}\n`,
        { mode: 0o700 },
      );
      const start = performance.now();
      const proc = Bun.spawn(
        [
          "sh",
          join(import.meta.dir, "../scripts/launch-agent.sh"),
          process.execPath,
          "--no-env-file",
          "-e",
          'console.log("INERT_AGENT_STARTED")',
        ],
        {
          env: {
            HOME: dir,
            PATH: process.env.PATH,
            PERCH_BUN: process.execPath,
            PERCH_TMUX: waiter,
            PERCH_RUN_ID: crypto.randomUUID(),
            TMUX_SOCKET: join(dir, "unused.sock"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      child = proc;
      expect(await new Response(proc.stdout).text()).toBe(
        "INERT_AGENT_STARTED\n",
      );
      expect(await proc.exited).toBe(0);
      if (mode === "never-release")
        expect(performance.now() - start).toBeGreaterThanOrEqual(2400);
      expect(performance.now() - start).toBeLessThan(5000);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
  6000,
);
