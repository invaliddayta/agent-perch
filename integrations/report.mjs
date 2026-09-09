import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

let pending = Promise.resolve();

// Only coarse state reaches tmux. No hook output, prompts, or tool arguments.
export function report(state, env = process.env) {
  const run = env.PERCH_RUN_ID;
  const pane = env.TMUX_PANE;
  const socket = env.PERCH_TMUX_SOCKET || env.TMUX?.replace(/,\d+,\d+$/, "");
  if (
    !/^[a-f0-9-]{36}$/.test(run || "") ||
    !/^%\d+$/.test(pane || "") ||
    !socket ||
    !env.PERCH_TMUX ||
    !["idle", "working", "ready", "attention", "error"].includes(state)
  )
    return Promise.resolve();
  const event = ["ready", "attention", "error"].includes(state)
    ? ` ; set-option -p -t ${pane} @perch_event ${run}:${randomUUID()}:${state}`
    : "";
  pending = pending
    .then(
      () =>
        new Promise((resolve) => {
          // The launch token and PID guard late callbacks after respawn/socket reuse.
          execFile(
            env.PERCH_TMUX,
            [
              "-S",
              socket,
              "if-shell",
              "-F",
              "-t",
              pane,
              `#{&&:#{==:#{@perch_run},${run}},#{==:#{@perch_pid},#{pane_pid}}}`,
              `set-option -p -t ${pane} @perch_state ${run}:${state}${event}`,
            ],
            { timeout: 1500, maxBuffer: 4096, env: { ...env, TMUX: "" } },
            () => resolve(),
          );
        }),
    )
    .catch(() => {});
  return pending;
}
