import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Backend, BackendId, Pane } from "../src/types";

export const backendDefinitions = {
  opencode: {
    label: "OpenCode",
    variable: "OPENCODE_BIN",
    executable: "opencode",
    environment: [
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ],
    args: (directory: string, prompt: string) => [
      directory,
      ...(prompt ? [`--prompt=${prompt}`] : []),
    ],
  },
  codex: {
    label: "Codex",
    variable: "CODEX_BIN",
    executable: "codex",
    environment: ["CODEX_HOME", "OPENAI_API_KEY"],
    args: (directory: string, prompt: string) => [
      "--cd",
      directory,
      ...(prompt ? ["--", prompt] : []),
    ],
  },
  pi: {
    label: "Pi",
    variable: "PI_BIN",
    executable: "pi",
    environment: [
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_OFFLINE",
      "PI_SKIP_VERSION_CHECK",
      "PI_TELEMETRY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ],
    // Pi still treats @arguments as files after --. A leading space keeps text literal.
    args: (_directory: string, prompt: string) =>
      prompt ? ["--", prompt.startsWith("@") ? " " + prompt : prompt] : [],
  },
  deepseek: {
    label: "DeepSeek Harness",
    variable: "DEEPSEEK_BIN",
    executable: "dsh-tui",
    environment: ["DSH_HOME", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"],
    args: undefined,
  },
};

export function backends(env = process.env): Backend[] {
  return Object.entries(backendDefinitions).map(([id, backend]) => ({
    id: id as BackendId,
    label: backend.label,
    available: !!Bun.which(env[backend.variable] || backend.executable),
    initialPrompt: !!backend.args,
  }));
}

export function terminalCommand(
  backend: BackendId,
  directory: string,
  prompt: string,
  env = process.env,
  extraArgs: string[] = [],
) {
  const { variable, executable: fallback, args } = backendDefinitions[backend];
  const executable = Bun.which(env[variable] || fallback);
  if (!executable)
    throw new Error(
      `${fallback} executable is unavailable. Configure ${variable} on the host.`,
    );
  if (!args && prompt.trim())
    throw new Error(
      "DeepSeek Harness does not accept a starting prompt. Enter it in the terminal after launch.",
    );
  // Multiple tmux command arguments force direct exec, including paths with spaces.
  return [
    Bun.which("env") || "env",
    "--",
    executable,
    ...extraArgs,
    ...(args?.(directory, backend === "pi" ? prompt : prompt.trim()) || []),
  ];
}

export function backendFromArgv(argv: string[]): BackendId | undefined {
  const executable = basename(argv[0] || "");
  if (executable === "pi") return "pi";
  if (
    ["node", "bun"].includes(executable) &&
    /^.*\/node_modules\/@(?:earendil-works|mariozechner)\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js$/.test(
      argv[1] || "",
    )
  )
    return "pi";
  if (executable === "codex") return "codex";
  // The pinned Nix launcher execs Node. Never classify arbitrary Node apps as agents.
  if (
    executable === "node" &&
    argv.some((arg) => arg.endsWith("/libexec/dsh/lib/bin.js")) &&
    argv.some(
      (arg, i) => arg === "--profile" && argv[i + 1] === "deepseek-harness-tui",
    )
  )
    return "deepseek";
}

// Include process start time so PID reuse cannot revive an upload destination.
export async function piProcessIdentity(
  rootPid: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return;
  const queue = [rootPid];
  const matches: string[] = [];
  try {
    for (let i = 0; i < queue.length; i++) {
      if (i >= 16) return; // A truncated or ambiguous tree is not a safe target.
      const pid = queue[i];
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).split(" ");
      const start = fields[19]; // Field 22; comm may contain spaces or parentheses.
      if (end < 0 || !/^\d+$/.test(start || "") || fields[0] === "Z") return;
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (
        stat.slice(stat.indexOf("(") + 1, end) === "pi" ||
        backendFromArgv(argv) === "pi"
      )
        matches.push(`${pid}:${start}`);
      const children = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf8",
      );
      queue.push(
        ...children
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => n > 0),
      );
    }
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return; // Exited or inaccessible identities fail closed.
  }
}

export async function paneBackend(pane: Pane): Promise<BackendId | undefined> {
  if (pane.dead) return;
  if (
    pane.command === "opencode" ||
    pane.command === "codex" ||
    pane.command === "pi"
  )
    return pane.command;
  if (!["node", "bun", "dsh-tui", "dsh"].includes(pane.command) || !pane.pid)
    return;
  // CLI wrappers may retain a parent process. Bound the read-only process walk.
  const queue = [pane.pid];
  for (let i = 0; i < queue.length && i < 16; i++) {
    const pid = queue[i];
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      const backend = backendFromArgv(argv);
      if (backend) return backend;
      const children = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf8",
      );
      queue.push(
        ...children
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => n > 0),
      );
    } catch {
      /* Exited or inaccessible processes are not recognized agents. */
    }
  }
}
