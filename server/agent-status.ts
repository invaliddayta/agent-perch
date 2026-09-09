import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackendId } from "../src/types";
import { report } from "../integrations/report.mjs";
import { watchAttention } from "./attention";
import { sessions, tmux, tmuxPrefix } from "./tmux";

export async function statusLaunch(
  backend: BackendId,
  stateDir: string,
  env = process.env,
) {
  const args: string[] = [];
  const environment: string[] = [];
  if (backend === "opencode") {
    const parsed = Bun.JSONC.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("OPENCODE_CONFIG_CONTENT must be an object.");
    const config = parsed as Record<string, unknown>;
    if (config.plugin !== undefined && !Array.isArray(config.plugin))
      throw new Error(
        "OPENCODE_CONFIG_CONTENT must be an object with an optional plugin array.",
      );
    const plugin = pathToFileURL(
      resolve(import.meta.dir, "../integrations/opencode.mjs"),
    ).href;
    environment.push(
      "OPENCODE_CONFIG_CONTENT=" +
        JSON.stringify({
          ...config,
          plugin: [
            ...(Array.isArray(config.plugin) ? config.plugin : []),
            plugin,
          ],
        }),
    );
  } else if (backend === "codex") {
    args.push(
      "--config",
      "tui.notifications=true",
      "--config",
      'tui.notification_method="osc9"',
      "--config",
      'tui.notification_condition="always"',
    );
  } else {
    const directory = join(stateDir, "integrations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const patch = join(directory, "deepseek.json");
    // JSON is valid YAML; absolute module paths survive arbitrary project cwd.
    await writeFile(
      patch,
      JSON.stringify([
        {
          insert: [
            {
              id: "perch-events",
              name: resolve(import.meta.dir, "../integrations/deepseek.mjs"),
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );
    args.push("--patch", patch);
  }
  return { args, environment };
}

const monitors = new Map<
  string,
  { proc: Bun.Subprocess; ready: Promise<void> }
>();
let pending = Promise.resolve();
let stopped = false;
let timer: ReturnType<typeof setTimeout>;

export function syncAttention(): Promise<void> {
  // Fresh snapshots and one queue: HTTP polls cannot race observer ownership.
  return (pending = pending
    .catch(() => {})
    .then(async () => {
      if (stopped) return;
      const targets = (await sessions()).flatMap((session) =>
        session.panes
          .filter((pane) => !pane.dead && pane.status?.backend === "codex")
          .map((pane) => ({
            session,
            pane,
            key: `${session.id}@${session.created}:${pane.status!.run}`,
          })),
      );
      for (const [key, monitor] of monitors) {
        if (!targets.some((target) => target.key === key)) {
          monitors.delete(key);
          monitor.proc.kill();
        }
      }
      for (const { session, pane, key } of targets) {
        if (monitors.has(key)) continue;
        const identity = `${pane.id}:${pane.status!.run}:${pane.pid}:${pane.pid}`;
        const current = await tmux(
          "display-message",
          "-p",
          "-t",
          pane.id,
          "#{pane_id}:#{@perch_run}:#{pane_pid}:#{@perch_pid}",
        ).catch(() => "");
        if (current !== identity) continue;
        const socket = await tmux(
          "display-message",
          "-p",
          "-t",
          session.id,
          "#{socket_path}",
        ).catch(() => "");
        if (!socket) continue;
        if (stopped) return;
        const { proc, ready } = watchAttention(
          session.id,
          (id) => {
            if (id !== pane.id) return;
            void report("attention", {
              ...process.env,
              TMUX_PANE: id,
              PERCH_RUN_ID: pane.status!.run,
              PERCH_TMUX: tmuxPrefix[0],
              PERCH_TMUX_SOCKET: socket,
            });
          },
          () => {
            if (monitors.get(key)?.proc === proc) monitors.delete(key);
          },
        );
        monitors.set(key, { proc, ready });
      }
      // Status is optional. An observer failure must not break listing or roll back
      // any requested agent launch; the server's next reconciliation can retry.
      await Promise.all(
        [...monitors.values()].map((monitor) => monitor.ready.catch(() => {})),
      );
    }));
}

export function startAttention() {
  const poll = async () => {
    await syncAttention().catch(() => {});
    if (!stopped) timer = setTimeout(poll, 3500);
  };
  void poll();
}

export function stopAttention() {
  stopped = true;
  clearTimeout(timer);
  for (const monitor of monitors.values()) monitor.proc.kill();
  monitors.clear();
}
