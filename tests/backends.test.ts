import { expect, test } from "bun:test";
import {
  backends,
  backendFromArgv,
  paneBackend,
  piProcessIdentity,
  terminalCommand,
} from "../server/backends";
import type { Pane } from "../src/types";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("all backend availability depends only on executable presence", () => {
  const options = backends({
    OPENCODE_BIN: process.execPath,
    CODEX_BIN: process.execPath,
    DEEPSEEK_BIN: "/missing/dsh-tui",
    PI_BIN: process.execPath,
  });
  expect(options.map((b) => b.available)).toEqual([true, true, true, false]);
  expect(options.map((b) => b.initialPrompt)).toEqual([
    true,
    true,
    true,
    false,
  ]);
});

test("terminal launch keeps prompt text literal and preserves agent safety defaults", () => {
  const prompt =
    "--dangerously-bypass-approvals-and-sandbox $(touch /tmp/no) 'quoted'\nnext";
  expect(
    terminalCommand("codex", "/projects/a b", prompt, {
      CODEX_BIN: process.execPath,
    }).slice(1),
  ).toEqual(["--", process.execPath, "--cd", "/projects/a b", "--", prompt]);
  expect(
    terminalCommand("opencode", "/projects/a b", "--auto " + prompt, {
      OPENCODE_BIN: process.execPath,
    }).slice(1),
  ).toEqual([
    "--",
    process.execPath,
    "/projects/a b",
    "--prompt=--auto " + prompt,
  ]);
  expect(
    terminalCommand("opencode", "/projects", "", {
      OPENCODE_BIN: process.execPath,
    }).slice(1),
  ).toEqual(["--", process.execPath, "/projects"]);
  expect(
    terminalCommand("deepseek", "/projects", "", {
      DEEPSEEK_BIN: process.execPath,
    }).slice(1),
  ).toEqual(["--", process.execPath]);
  expect(() =>
    terminalCommand("deepseek", "/projects", "do work", {
      DEEPSEEK_BIN: process.execPath,
    }),
  ).toThrow("starting prompt");
  for (const [backend, variable] of [
    ["opencode", "OPENCODE_BIN"],
    ["codex", "CODEX_BIN"],
    ["deepseek", "DEEPSEEK_BIN"],
  ] as const)
    expect(() =>
      terminalCommand(backend, "/projects", "", {
        [variable]: "/missing/agent",
      }),
    ).toThrow(variable);
});

test("recognition identifies the pinned DeepSeek process, not arbitrary Node applications", async () => {
  expect(backendFromArgv(["/bin/codex", "--cd", "/work"])).toBe("codex");
  expect(
    backendFromArgv([
      "node",
      "--expose-internals",
      "/nix/store/example/libexec/dsh/lib/bin.js",
      "--profile",
      "deepseek-harness-tui",
    ]),
  ).toBe("deepseek");
  expect(
    backendFromArgv(["node", "/app/server.js", "deepseek-harness-tui"]),
  ).toBeUndefined();
  expect(
    backendFromArgv([
      "node",
      "/nix/store/example/libexec/dsh/lib/bin.js",
      "--profile",
      "other",
    ]),
  ).toBeUndefined();
  expect(
    await paneBackend({ command: "codex", dead: true } as Pane),
  ).toBeUndefined();
  expect(
    await paneBackend({ command: "sh", dead: false } as Pane),
  ).toBeUndefined();
});

test("Pi process identity includes start time and fails closed for missing or ambiguous processes", async () => {
  for (const pid of [0, -1, NaN, 999999999])
    expect(await piProcessIdentity(pid)).toBeUndefined();
  const dir = await mkdtemp(join(tmpdir(), "perch-pi-identity-"));
  try {
    const fakeDir = join(
      dir,
      "node_modules/@earendil-works/pi-coding-agent/dist",
    );
    await mkdir(fakeDir, { recursive: true });
    const fake = join(fakeDir, "cli.js");
    await writeFile(
      fake,
      `if (process.argv[2] === "ambiguous") { const child = Bun.spawn([process.execPath, import.meta.path], { stdout: "inherit" }); process.on("SIGTERM", async () => { child.kill(); await child.exited; process.exit(); }); } else console.log("ready"); setInterval(() => {}, 1000);`,
    );
    for (const ambiguous of [false, true]) {
      const child = Bun.spawn(
        [process.execPath, fake, ...(ambiguous ? ["ambiguous"] : [])],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        await child.stdout.getReader().read();
        const identity = await piProcessIdentity(child.pid);
        if (ambiguous) expect(identity).toBeUndefined();
        else {
          const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
          expect(identity).toBe(
            `${child.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`,
          );
        }
      } finally {
        child.kill();
        await child.exited;
      }
      expect(await piProcessIdentity(child.pid)).toBeUndefined();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi initial prompts remain literal, including CLI file and option syntax", () => {
  for (const prompt of [
    "@private.txt",
    "--no-approve",
    "  ordinary  ",
    "first\nsecond",
    "",
    " ",
    "$(touch nope)",
  ]) {
    const command = terminalCommand("pi", "/work with spaces", prompt, {
      PI_BIN: process.execPath,
    });
    expect(command.slice(1)).toEqual([
      "--",
      process.execPath,
      ...(prompt ? ["--", prompt.startsWith("@") ? " " + prompt : prompt] : []),
    ]);
  }
  for (const scope of ["earendil-works", "mariozechner"]) {
    expect(
      backendFromArgv([
        "node",
        `/opt/node_modules/@${scope}/pi-coding-agent/dist/cli.js`,
      ]),
    ).toBe("pi");
    expect(
      backendFromArgv([
        "node",
        `/opt/node_modules/@${scope}/pi-coding-agent/dist/bundle/cli.js`,
      ]),
    ).toBe("pi");
  }
  expect(
    backendFromArgv([
      "node",
      "/app/cli.js",
      "/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ]),
  ).toBeUndefined();
  expect(backendFromArgv(["pi"])).toBe("pi");
});
