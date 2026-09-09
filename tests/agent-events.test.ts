import { describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique virtual reporter modules keep these mocks out of report.mjs's tests.
// The adapter code is unchanged except for resolving its one dependency.
let serial = 0;
async function adapter(name: string, reporter?: (state: string) => unknown) {
  const states: string[] = [];
  const dependency = join(
    tmpdir(),
    `perch-events-virtual-${process.pid}-${serial++}.mjs`,
  );
  mock.module(dependency, () => ({
    report(state: string) {
      states.push(state);
      return reporter?.(state);
    },
  }));
  const source = await readFile(
    new URL(`../integrations/${name}.mjs`, import.meta.url),
    "utf8",
  );
  const url = URL.createObjectURL(
    new Blob(
      [source.replace(/(["'])\.\/report\.mjs\1/, JSON.stringify(dependency))],
      {
        type: "text/javascript",
      },
    ),
  );
  const mod = await import(url);
  URL.revokeObjectURL(url);
  return { mod, states };
}

async function opencode(reporter?: (state: string) => unknown) {
  const { mod, states } = await adapter("opencode", reporter);
  const hooks = await mod.default();
  const event = (type: string, properties: Record<string, unknown> = {}) =>
    hooks.event({ event: { type, properties } });
  const session = (id = "root", parentID?: string, type = "session.created") =>
    event(type, { info: { id, ...(parentID ? { parentID } : {}) } });
  const status = (type: string, sessionID = "root") =>
    event("session.status", { sessionID, status: { type } });
  const user = (id = "user1", sessionID = "root") =>
    event("message.updated", { info: { role: "user", id, sessionID } });
  const assistant = (extra: Record<string, unknown> = {}, sessionID = "root") =>
    event("message.updated", {
      info: {
        role: "assistant",
        id: "msg1",
        parentID: "user1",
        sessionID,
        time: { completed: 123 },
        finish: "stop",
        ...extra,
      },
    });
  return { mod, hooks, states, event, session, status, user, assistant };
}

async function deepseek(
  reporter?: (state: string) => unknown,
  initial = "idle",
) {
  const { mod, states } = await adapter("deepseek", reporter);
  const root = { id: "main-session-uuid", session: {}, status: initial };
  const child = { id: "child", session: {}, status: "idle" };
  const other = { id: "other-root", session: {}, status: "idle" };
  const listeners = new Map<
    string,
    { fn: (...args: any[]) => any; options?: any }
  >();
  const ctx = {
    tuiStartup: { sessionId: root.id },
    agents: {
      get: (id: string) => [root, child, other].find((a) => a.id === id),
      roots: () => [root, other],
    },
    on(name: string, fn: (...args: any[]) => any, options?: any) {
      listeners.set(name, { fn, options });
    },
  };
  mod.apply(ctx);
  const emit = (name: string, ...args: any[]) =>
    listeners.get(name)?.fn(...args);
  const event = (type: string, data: Record<string, unknown>, subject = root) =>
    emit("session/event", subject.session, { type, data });
  const start = (turn = 1, subject = root, source = "user") => {
    event("turn/start", { turn }, subject);
    emit("agent/inbox/claimed", {
      agent: subject,
      turn,
      message: { source: { kind: source } },
    });
    event("step/start", { turn, step: 1 }, subject);
  };
  const end = (turn = 1, kind = "completed", subject = root) =>
    event("turn/end", { turn, reason: { kind } }, subject);
  return {
    mod,
    states,
    root,
    child,
    other,
    ctx,
    listeners,
    emit,
    event,
    start,
    end,
  };
}

describe("OpenCode native event adapter (v1.18.3)", () => {
  test("one plugin export, observation-only hooks, no speculative initial idle", async () => {
    const a = await opencode();
    expect(Object.keys(a.mod)).toEqual(["default"]);
    expect(Object.keys(a.hooks).sort()).toEqual(["dispose", "event"]);
    expect(a.states).toEqual([]);
    await a.session("root", undefined, "session.updated");
    await a.status("idle");
    expect(a.states).toEqual([]);
    await a.session("new");
    expect(a.states).toEqual(["idle"]);
  });

  test("unknown and subtree events never claim root readiness or attention", async () => {
    const a = await opencode();
    await a.session("child", "root");
    for (const id of ["unknown", "child"]) {
      await a.user("user1", id);
      await a.status("busy", id);
      await a.assistant({}, id);
      await a.event("permission.asked", { sessionID: id, id: "approval" });
      await a.event("session.error", { sessionID: id, error: {} });
      await a.status("idle", id);
    }
    expect(a.states).toEqual([]);
  });

  test("ready requires observed root work, successful final assistant, and idle", async () => {
    const a = await opencode();
    await a.session();
    await a.status("idle");
    await a.user();
    await a.status("busy");
    await a.assistant({ finish: "tool-calls" });
    expect(a.states).toEqual(["idle", "working"]);
    await a.assistant({ id: "msg2", time: {} });
    await a.assistant({ id: "msg2" });
    await a.status("busy"); // The native loop checks its exit after another busy event.
    expect(a.states.at(-1)).toBe("working");
    await a.status("idle");
    await a.event("session.idle", { sessionID: "root" });
    await a.status("idle");
    expect(a.states).toEqual(["idle", "working", "ready"]);
  });

  test("resume user event before native session.touch is retained without guessing lineage", async () => {
    const a = await opencode();
    await a.user();
    expect(a.states).toEqual([]);
    await a.session("root", undefined, "session.updated");
    expect(a.states).toEqual([]);
    await a.status("busy");
    await a.assistant();
    await a.status("idle");
    expect(a.states).toEqual(["working", "ready"]);
  });

  test.each(["length", "tool-calls", "unknown"])(
    "finish %s is not success",
    async (finish) => {
      const a = await opencode();
      await a.session();
      await a.user();
      await a.status("busy");
      await a.assistant({ finish });
      await a.status("idle");
      expect(a.states).toEqual(["idle", "working", "idle"]);
    },
  );

  test("errors, aborted assistants, summaries and idle-only cancellation are not success", async () => {
    for (const extra of [
      { error: { name: "MessageAbortedError" } },
      { summary: true },
      { time: {} },
    ]) {
      const a = await opencode();
      await a.session();
      await a.user();
      await a.status("busy");
      await a.assistant(extra);
      await a.status("idle");
      expect(a.states).not.toContain("ready");
    }
    const a = await opencode();
    await a.session();
    await a.user();
    await a.status("busy");
    await a.assistant();
    await a.event("session.error", { sessionID: "root", error: {} });
    await a.status("idle");
    expect(a.states.at(-1)).toBe("error");
  });

  test("provider stop with tool calls is not a completed final reply", async () => {
    const a = await opencode();
    await a.session();
    await a.user();
    await a.status("busy");
    await a.assistant({ time: {} });
    await a.event("message.part.updated", {
      part: { sessionID: "root", messageID: "msg1", type: "tool" },
    });
    await a.assistant();
    await a.status("idle");
    expect(a.states).not.toContain("ready");
  });

  test("overlapping request IDs are namespaced and replies do not prematurely clear attention", async () => {
    const a = await opencode();
    await a.session();
    await a.user();
    await a.status("busy");
    await a.event("permission.asked", { sessionID: "root", id: "same" });
    await a.event("question.asked", { sessionID: "root", id: "same" });
    await a.event("permission.asked", { sessionID: "root", id: "second" });
    await a.event("permission.replied", {
      sessionID: "root",
      requestID: "same",
    });
    await a.event("permission.replied", {
      sessionID: "root",
      requestID: "second",
    });
    await a.status("busy");
    expect(a.states.at(-1)).toBe("attention");
    await a.event("question.rejected", {
      sessionID: "root",
      requestID: "same",
    });
    expect(a.states.at(-1)).toBe("working");
  });

  test("old turn completions cannot finish the new user turn; other roots keep working", async () => {
    const a = await opencode();
    await a.session();
    await a.user();
    await a.status("busy");
    await a.assistant();
    await a.user("user2");
    await a.assistant();
    await a.status("idle");
    expect(a.states).not.toContain("ready");
    await a.session("second");
    await a.user("user1", "second");
    await a.status("busy", "second");
    await a.status("busy");
    await a.assistant({ id: "msg2", parentID: "user2" });
    await a.status("idle");
    expect(a.states.at(-1)).toBe("working");
    await a.assistant({}, "second");
    await a.status("idle", "second");
    expect(a.states.at(-1)).toBe("ready");
  });

  test("reporter throws/rejections/hangs and malformed events cannot interrupt native callbacks", async () => {
    for (const reporter of [
      () => {
        throw Error("observer");
      },
      () => Promise.reject(Error("observer")),
      () => new Promise(() => {}),
    ]) {
      const a = await opencode(reporter);
      await a.session();
      await a.user();
      await a.status("busy");
      await a.assistant();
      await a.status("idle");
      await a.hooks.event();
      await a.hooks.event({ event: null });
      await a.hooks.event(null);
      expect(a.states).toEqual(["idle", "working", "ready"]);
      await a.hooks.dispose();
      await a.status("busy");
      expect(a.states.at(-1)).toBe("ready");
    }
  });
});

describe("DeepSeek native event adapter (pinned Harness/TUI)", () => {
  test("initializes from exact live TUI root, not arbitrary root or same-id impostor", async () => {
    const a = await deepseek();
    expect(a.mod.inject).toEqual(["agents", "tuiStartup"]);
    expect(a.states).toEqual(["idle"]);
    expect((await deepseek(undefined, "running")).states).toEqual(["working"]);
    expect((await deepseek(undefined, "unknown")).states).toEqual([]);
    a.start(1, a.child);
    a.end(1, "completed", a.child);
    a.start(1, a.other);
    a.end(1, "completed", a.other);
    a.emit("agent/created", { agent: { ...a.root } });
    a.emit("agent/status", { agent: a.child, status: "running" });
    a.emit("agent/error", { agent: a.child, turn: 1 });
    expect(a.states).toEqual(["idle"]);
  });

  test("only completed stepped user turns are ready, not setup, no-op or plugin turns", async () => {
    const a = await deepseek();
    a.emit("agent/status", { agent: a.root, status: "idle" });
    a.event("turn/start", { turn: 1 });
    a.end();
    expect(a.states).not.toContain("ready");
    a.start(2, a.root, "plugin");
    a.end(2);
    expect(a.states).not.toContain("ready");
    a.start(3);
    a.end(3);
    a.end(3);
    a.emit("agent/status", { agent: a.root, status: "idle" });
    expect(a.states.at(-1)).toBe("ready");
  });

  test.each(["aborted", "interrupted", "error", "blocked", "max-tokens"])(
    "%s is never completed",
    async (kind) => {
      const a = await deepseek();
      a.start();
      a.end(1, kind);
      a.emit("agent/status", { agent: a.root, status: "idle" });
      expect(a.states).not.toContain("ready");
      if (kind === "error") expect(a.states.at(-1)).toBe("error");
    },
  );

  test("overlapping approval audits do not install or alter approval/request", async () => {
    const a = await deepseek();
    a.start();
    expect(a.listeners.has("approval/request")).toBe(false);
    a.event("approval/asked", { id: "a" });
    a.event("approval/asked", { id: "b" });
    a.event("approval/decided", { id: "a", outcome: "rejected" });
    a.event("approval/decided", { id: "unknown", outcome: "allowed-once" });
    expect(a.states.at(-1)).toBe("attention");
    a.event("approval/decided", { id: "b", outcome: "allowed-once" });
    expect(a.states.at(-1)).toBe("working");
    a.end();
    expect(a.states.at(-1)).toBe("ready");
  });

  test("question waterfall always delegates once and preserves result/error; overlapping requests remain attention", async () => {
    const a = await deepseek();
    a.start();
    expect(a.listeners.get("user-questions/request")?.options).toEqual({
      prepend: true,
    });
    let finish!: (value: unknown) => void;
    const result = Object.freeze({ answer: "native answer" });
    const request = Object.freeze({
      agent: a.root,
      questions: Object.freeze([]),
    });
    const next = mock(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = a.emit("user-questions/request", request, next);
    const error = Error("native failure");
    await expect(
      a.emit("user-questions/request", request, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(a.states.at(-1)).toBe("attention");
    finish(result);
    expect(await pending).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    expect(a.states.at(-1)).toBe("working");
    expect(
      await a.emit("user-questions/request", { agent: a.child }, () => result),
    ).toBe(result);
    expect(a.states.at(-1)).toBe("working");
  });

  test("late root turn ends and late question settlements cannot overwrite the next turn", async () => {
    const a = await deepseek();
    a.start();
    let resolve!: () => void;
    const pending = a.emit(
      "user-questions/request",
      { agent: a.root },
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    a.end(1, "aborted");
    a.start(2);
    a.event("approval/asked", { id: "new" });
    a.end(1);
    resolve();
    await pending;
    expect(a.states.at(-1)).toBe("attention");
    a.event("approval/decided", { id: "new" });
    a.end(2);
    expect(a.states.at(-1)).toBe("ready");
  });

  test("observer failures never block, answer, or swallow native failures", async () => {
    for (const reporter of [
      () => {
        throw Error("observer");
      },
      () => Promise.reject(Error("observer")),
      () => new Promise(() => {}),
    ]) {
      const a = await deepseek(reporter);
      a.start();
      a.emit("agent/created", null);
      a.emit("agent/status", null);
      a.emit("agent/error", null);
      const answer = {};
      expect(
        await a.emit("user-questions/request", { agent: a.root }, () => answer),
      ).toBe(answer);
      a.ctx.agents.roots = () => {
        throw Error("observer identity lookup");
      };
      const next = mock(() => answer);
      expect(
        await a.emit("user-questions/request", { agent: a.root }, next),
      ).toBe(answer);
      expect(next).toHaveBeenCalledTimes(1);
      const error = Error("native");
      await expect(
        a.emit("user-questions/request", { agent: a.root }, () =>
          Promise.reject(error),
        ),
      ).rejects.toBe(error);
    }
  });
});

const runtime = process.env.PERCH_TEST_DSH_RUNTIME;
test.skipIf(!runtime || !existsSync(`${runtime}/cordis/lib/index.js`))(
  "installed Cordis loads observer and composes real scoped question waterfall without a provider",
  async () => {
    const { Context } = await import(`${runtime}/cordis/lib/index.js`);
    const { AgentRegistry, agentEvents } = await import(
      `${runtime}/dsh-agent/lib/index.js`
    );
    const { applyEntryPatches } = await import(
      `${runtime}/cordis-plugin-include/lib/index.js`
    );
    const { mod, states } = await adapter("deepseek");
    const ctx = new Context();
    try {
      const registry = new AgentRegistry(ctx);
      ctx.provide("tuiStartup", { sessionId: "native-root" });
      const patch = [
        {
          insert: [
            {
              id: "perch-events",
              name: new URL("../integrations/deepseek.mjs", import.meta.url)
                .pathname,
            },
          ],
        },
      ];
      expect(
        applyEntryPatches([], patch, () => {
          throw Error("invalid patch");
        }),
      ).toEqual(patch[0]!.insert);
      const root = {
        id: "native-root",
        session: { id: "native-root" },
        status: "idle",
      };
      const remove = registry.enter(root, undefined);
      const observer = ctx.plugin(mod);
      await observer;
      registry.announce(root);
      expect(states).toEqual(["idle"]);
      const answer = Object.freeze({ chosen: "native answer" });
      let calls = 0;
      ctx.on("user-questions/request", () => {
        calls++;
        return answer;
      });
      const result = await agentEvents(ctx, root).waterfall(
        "user-questions/request",
        {},
        () => {
          throw Error("answerer skipped");
        },
      );
      expect(result).toBe(answer);
      expect(calls).toBe(1);
      expect(states).toEqual(["idle", "attention", "idle"]);
      remove();
    } finally {
      await ctx.fiber.dispose();
    }
  },
);
