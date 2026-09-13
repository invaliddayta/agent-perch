import { expect, test } from "bun:test";
import { readConfig } from "../server/config";
import { serviceUnit } from "../scripts/install";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";

test("configuration derives portable defaults without an OpenCode service", () => {
  const config = readConfig(
    {
      HOME: "/users/tester",
      OPENCODE_URL: "obsolete",
      OPENCODE_DB_PATH: "/missing/db",
    },
    "/work/perch",
  );
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(4310);
  expect(config.projectsRoot).toBe("/users/tester");
  expect(config.stateDir).toBe("/work/perch/.state");
  expect(config.publicOrigin).toBeUndefined();
  expect([...config.origins]).toEqual([
    "http://127.0.0.1:4310",
    "http://localhost:4310",
  ]);
  expect(config).not.toHaveProperty("opencodeURL");
  expect(config).not.toHaveProperty("dbPath");
});

test("configuration honors custom paths, ports and exact origins", () => {
  const config = readConfig(
    {
      HOME: "/users/tester",
      PROJECTS_ROOT: "~/projects",
      STATE_DIR: "private-state",
      DIST_DIR: "/build",
      PORT: "5432",
      PUBLIC_ORIGIN: "https://example.ts.net/",
      DEV_ORIGIN: "http://localhost:5173/",
    },
    "/work/app",
  );
  expect(config.projectsRoot).toBe("/users/tester/projects");
  expect(config.stateDir).toBe("/work/app/private-state");
  expect(config.distDir).toBe("/build");
  expect(config.origins.has("https://example.ts.net")).toBe(true);
  expect(config.origins.has("http://127.0.0.1:5432")).toBe(true);
});

test("invalid ports and non-origin URLs fail closed", () => {
  for (const PORT of ["0", "-1", "65536", "1.5", "NaN"])
    expect(() => readConfig({ PORT })).toThrow("PORT");
  for (const value of [
    "file:///tmp",
    "https://user:password@host",
    "https://host/path",
    "https://host/?key=value",
    "https://host/#fragment",
  ])
    for (const key of ["PUBLIC_ORIGIN", "DEV_ORIGIN"])
      expect(() => readConfig({ [key]: value })).toThrow(key);
});

test("the single service quotes discovered paths and requires no OpenCode backend", () => {
  const unit = serviceUnit(
    '/opt/My "app" %name $data',
    "/tools/Bun runtime/bun",
    "/tools/bin:/usr/bin",
  );
  expect(unit).toContain('WorkingDirectory="/opt/My \\"app\\" %%name $data"');
  expect(unit).toContain('ExecStart=:"/tools/Bun runtime/bun" --no-env-file');
  expect(unit).toContain("%%name $data/server/index.ts");
  expect(unit).not.toContain("opencode");
  expect(unit).not.toContain("Wants=");
  expect(() => serviceUnit("/app\nBad=1", "/bun", "/bin")).toThrow();
});

test("installer is inert in dry run, preserves private config, and only installs the web service", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "perch-install-"));
  const root = join(temporary, "App with spaces %literal $cash");
  const bin = join(temporary, "bin");
  const envFile = join(root, ".env");
  const configHome = join(temporary, "config");
  try {
    for (const directory of [bin, join(root, "scripts"), join(root, "server")])
      await mkdir(directory, { recursive: true });
    for (const file of ["scripts/install.ts", "server/config.ts"])
      await copyFile(join(import.meta.dir, "..", file), join(root, file));
    // No OpenCode executable is installed in this fixture.
    for (const name of ["tmux", "systemctl"])
      await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const run = async (dry: boolean, legacyFlag = false) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(root, "scripts/install.ts"),
          ...(dry ? ["--dry-run"] : []),
          ...(legacyFlag ? ["--terminal-only"] : []),
        ],
        {
          cwd: root,
          env: {
            HOME: temporary,
            XDG_CONFIG_HOME: configHome,
            PATH: bin,
            PORT: "5432",
            OPENCODE_BIN: "/tools/opencode",
            CODEX_BIN: "/tools/codex",
            DEEPSEEK_BIN: "/tools/dsh-tui",
            CODEX_HOME: "/private/codex",
            DSH_HOME: "/private/dsh",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status) throw new Error(error);
      return output;
    };
    expect(await run(true)).toContain("No files or services changed");
    expect(await Bun.file(envFile).exists()).toBe(false);
    expect(
      await Bun.file(
        join(configHome, "systemd/user/agent-watch.service"),
      ).exists(),
    ).toBe(false);
    await run(false);
    const before = await readFile(envFile, "utf8");
    const values = parseEnv(before);
    expect(values.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(values.PORT).toBe("5432");
    expect(values.OPENCODE_BIN).toBe("/tools/opencode");
    expect(values.CODEX_BIN).toBe("/tools/codex");
    expect(values.DEEPSEEK_BIN).toBe("/tools/dsh-tui");
    expect(values.CODEX_HOME).toBe("/private/codex");
    expect(values.DSH_HOME).toBe("/private/dsh");
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(configHome, "systemd/user"))).toEqual([
      "agent-watch.service",
    ]);
    const privateConfig =
      before + "OPENCODE_SERVER_PASSWORD=retained-fixture-secret\n";
    await writeFile(envFile, privateConfig);
    expect(await run(true)).not.toContain("retained-fixture-secret");
    await run(false);
    expect(await readFile(envFile, "utf8")).toBe(privateConfig);
    expect(await run(true, true)).not.toContain(
      "# agent-watch-opencode.service",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("HOST changes the listener only, never origin authorization", () => {
  for (const HOST of ["0.0.0.0", "::", "127.0.0.2", "localhost"]) {
    const config = readConfig({ HOST });
    expect(config.host).toBe(HOST);
    expect([...config.origins]).toEqual([
      "http://127.0.0.1:4310",
      "http://localhost:4310",
    ]);
  }
  for (const HOST of [
    "http://localhost",
    "localhost:4310",
    "bad\nhost",
    " /tmp/socket",
    "[::1]",
  ])
    expect(() => readConfig({ HOST })).toThrow("HOST");
});
