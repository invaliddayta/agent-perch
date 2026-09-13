import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import { readConfig } from "../server/config";

export function serviceUnit(root: string, bun: string, path: string) {
  const quote = (value: string) => {
    if (/[\r\n\0]/.test(value))
      throw new Error("Service paths cannot contain line breaks or NUL.");
    return JSON.stringify(value.replaceAll("%", "%%"));
  };
  // ':' disables systemd's dollar expansion; keep the deployed unit name.
  return `[Unit]
Description=Agent Perch private terminal
After=network-online.target

[Service]
WorkingDirectory=${quote(root)}
EnvironmentFile=${quote(join(root, ".env"))}
Environment=${quote(`PATH=${path}`)}
ExecStart=:${quote(bun)} --no-env-file ${quote(join(root, "server/index.ts"))}
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: bun run install:service [--dry-run]\nInstall one Linux user service. Existing .env files and running services are preserved. Dry run writes nothing.",
    );
  } else {
    // Older installations used this flag; terminal-only is now the only mode.
    if (args.some((arg) => !["--dry-run", "--terminal-only"].includes(arg)))
      throw new Error("Unknown option. Use --help.");
    if (
      process.platform !== "linux" ||
      !Bun.which("tmux") ||
      !Bun.which("systemctl")
    )
      throw new Error(
        "The service installer requires Linux, tmux, and systemd user-service support.",
      );
    const root = resolve(import.meta.dir, "..");
    const envFile = join(root, ".env");
    let content: string;
    let exists = true;
    try {
      content = await readFile(envFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
      const config = readConfig();
      const values: Record<string, string> = {
        PUBLIC_ORIGIN: config.publicOrigin || "",
        PORT: String(config.port),
        PROJECTS_ROOT: config.projectsRoot,
      };
      for (const key of [
        "STATE_DIR",
        "DIST_DIR",
        "TMUX_SOCKET",
        "DEV_ORIGIN",
        "OPENCODE_BIN",
        "CODEX_BIN",
        "DEEPSEEK_BIN",
        "PI_BIN",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "PI_ATTENTION",
        "CODEX_HOME",
        "DSH_HOME",
      ])
        if (process.env[key]) values[key] = process.env[key]!;
      content =
        Object.entries(values)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n") + "\n";
    }
    readConfig({ ...process.env, ...parseEnv(content) }, root);
    // Do not persist Bun's temporary package-script shims into a service.
    const path = [
      ...new Set([
        ...(process.env.PATH || "")
          .split(":")
          .filter(
            (entry) =>
              isAbsolute(entry) &&
              !entry.endsWith("/node_modules/.bin") &&
              !/\/bun-node-[^/]+$/.test(entry),
          ),
        dirname(process.execPath),
        dirname(Bun.which("tmux")!),
      ]),
    ].join(":");
    const unit = serviceUnit(root, process.execPath, path);
    const unitDir = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "systemd/user",
    );
    if (args.includes("--dry-run")) {
      console.log(
        `${exists ? "Preserve" : "Create private"} ${envFile}\nService directory: ${unitDir}\nNo files or services changed.\n\n# agent-watch.service\n${unit}`,
      );
    } else {
      if (!exists)
        await writeFile(envFile, content, { mode: 0o600, flag: "wx" });
      await chmod(envFile, 0o600);
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(unitDir, "agent-watch.service"), unit, {
        mode: 0o600,
      });
      for (const args of [
        ["daemon-reload"],
        ["enable", "--now", "agent-watch.service"],
      ]) {
        const child = Bun.spawn(["systemctl", "--user", ...args], {
          stdout: "inherit",
          stderr: "inherit",
        });
        if (await child.exited) throw new Error("systemctl failed");
      }
      console.log(
        "User service installed. Already-running services were not restarted. Configure private HTTPS and PUBLIC_ORIGIN before remote access. Existing OpenCode services were not changed.",
      );
    }
  }
}
