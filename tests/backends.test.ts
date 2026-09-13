import { expect, test } from "bun:test";
import {
  backends,
  backendFromArgv,
  paneBackend,
  terminalCommand,
} from "../server/backends";
import type { Pane } from "../src/types";

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
