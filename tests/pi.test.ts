import { expect, test } from "bun:test";
import { piImageReference } from "../src/image-reference";
import { statusLaunch } from "../server/agent-status";
import { readFile } from "node:fs/promises";

test("Pi image references delimit literal paths without terminal controls or shell expansion", () => {
  for (const path of [
    "/state/images/a.png",
    '/state/a b/\"$()`;\\/image.png',
  ]) {
    const text = piImageReference(path);
    expect(JSON.parse(text.trim())).toBe(path);
    expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(text.startsWith(" ")).toBe(true);
    expect(text.endsWith(" ")).toBe(true);
  }
  for (const path of [
    "relative.png",
    "/state/\nimage.png",
    "/state/\x1b[201~.png",
    "/state/\x00.png",
  ])
    expect(() => piImageReference(path)).toThrow();
});

test("Pi lifecycle is opt-in, local, and never modifies agent configuration", async () => {
  expect(await statusLaunch("pi", "/unused", {})).toEqual({
    args: [],
    environment: [],
  });
  const launch = await statusLaunch("pi", "/unused", { PI_ATTENTION: "1" });
  expect(launch.environment).toEqual([]);
  expect(launch.args).toEqual([
    "--extension",
    new URL("../integrations/pi.mjs", import.meta.url).pathname,
  ]);
});

test("Pi settles conservatively, observes UI without granting approvals, and stores no content", async () => {
  const source = await readFile(
    new URL("../integrations/pi.mjs", import.meta.url),
    "utf8",
  );
  const url = URL.createObjectURL(
    new Blob(
      [
        source.replace(
          'import { report } from "./report.mjs";',
          "const report = () => {};",
        ),
      ],
      { type: "text/javascript" },
    ),
  );
  const { observePi } = await import(url);
  URL.revokeObjectURL(url);
  const hooks = new Map<string, Function>();
  const states: string[] = [];
  observePi(
    { on: (name: string, fn: Function) => hooks.set(name, fn) },
    (state: string) => {
      states.push(state);
    },
  );
  const fire = (name: string, event = {}, idle = true) =>
    hooks.get(name)!(event, { isIdle: () => idle });
  fire("session_start");
  fire("agent_settled");
  expect(states).toEqual(["idle", "idle"]);
  for (const [reason, state] of [
    ["stop", "ready"],
    ["error", "error"],
    ["aborted", "idle"],
    ["toolUse", "idle"],
  ]) {
    fire("agent_start");
    fire("message_end", {
      message: { role: "assistant", stopReason: reason, content: "PRIVATE" },
    });
    fire("agent_settled", {}, false);
    expect(states.at(-1)).toBe("working");
    fire("agent_settled");
    expect(states.at(-1)).toBe(state);
  }
  expect(
    fire("ui_prompt_start", { title: "PRIVATE", kind: "confirm" }),
  ).toBeUndefined();
  expect(states.at(-1)).toBe("attention");
  fire("ui_prompt_end");
  expect(states.at(-1)).toBe("idle");
  expect([...hooks.keys()]).not.toContain("tool_call");
  expect([...hooks.keys()]).not.toContain("project_trust");
  expect(JSON.stringify(states)).not.toContain("PRIVATE");
});
