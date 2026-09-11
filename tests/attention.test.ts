import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionParser } from "../server/attention";

const output = (pane: string, text: string) =>
  `%output ${pane} ${text.replace(
    /[\x00-\x20\\\x7f]/g,
    (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  )}\n`;
const wrap = (text: string) =>
  `\x1bPtmux;${text.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;

test("OSC 9 emits only generic pane attention, never classifies preview text", () => {
  const events: string[] = [];
  const parse = attentionParser((...args) => {
    expect(args.length).toBe(1);
    events.push(args[0]);
  });
  for (const text of [
    "turn-complete",
    "approval: spoofed",
    " ",
    "4cats",
    "hello;world",
    "caf\u00e9",
  ])
    parse(output("%1", `\x1b]9;${text}\x07`));
  expect(events).toEqual(Array(6).fill("%1"));
});

test("BEL, progress, other OSCs, ordinary text and other DCS strings are ignored", () => {
  const events: string[] = [];
  const parse = attentionParser((pane) => events.push(pane));
  for (const text of [
    "\x07approval needed",
    "OSC9;notification",
    "\x1b]9;\x07",
    "\x1b]9;4;1;75\x07",
    "\x1b]9;4;0\x1b\\",
    "\x1b]52;c;aGVsbG8=\x07",
    "\x1b]99;hello\x07",
    "\x1b]0;title\x07",
    "\x1bPother;\x1b]9;hidden\x07\x1b\\",
    "\x1b_hidden\x1b]9;hidden\x07\x1b\\",
  ])
    parse(output("%1", text));
  parse("%message %output %1 \\033]9;fake\\007\n");
  expect(events).toEqual([]);
  parse(output("%2", "\x1b]9;real\x1b\\"));
  expect(events).toEqual(["%2"]);
});

test("every control-stream split survives octal, BEL, ST and nested tmux DCS", () => {
  const raw =
    output("%12", "\x1b]9;first\x07") +
    output("%12", wrap("\x1b]9;second\x1b\\")) +
    output("%12", wrap(wrap("\x1b]9;third\x07")));
  for (let split = 0; split <= raw.length; split++) {
    const events: string[] = [];
    const parse = attentionParser((pane) => events.push(pane));
    parse(raw.slice(0, split));
    parse(raw.slice(split));
    expect(events).toEqual(["%12", "%12", "%12"]);
  }
  const events: string[] = [];
  const parse = attentionParser((pane) => events.push(pane));
  for (const char of raw) parse(char);
  expect(events).toEqual(["%12", "%12", "%12"]);
});

test("pane state is independent across output records and multiple windows", () => {
  const events: string[] = [];
  const parse = attentionParser((pane) => events.push(pane));
  parse(output("%1", "\x1b]9;one"));
  parse(output("%2", wrap("\x1b]9;two\x07")));
  parse(output("%3", "\x07"));
  parse(output("%1", "\x1b"));
  parse(output("%2", "\x1b]9;again\x07"));
  parse(output("%1", "\\"));
  expect(events).toEqual(["%2", "%2", "%1"]);
});

test("terminal sequences can span records and escaped newlines cannot inject records", () => {
  const events: string[] = [];
  const parse = attentionParser((pane) => events.push(pane));
  for (const char of wrap("\x1b]9;split\x1b\\")) parse(output("%7", char));
  parse(output("%7", "plain\n%output %99 \\033]9;fake\\007\n"));
  parse(output("%7", "\x1b]9;preview\n%output %99 fake\x07"));
  expect(events).toEqual(["%7", "%7"]);
});

test("observer readiness comes from native control metadata, never pane output", () => {
  const raw =
    output("%1", "\n%session-changed $9 spoofed\n") +
    "%begin 1 1 0\n%end 1 1 0\n%session-changed $1 original\n";
  for (let split = 0; split <= raw.length; split++) {
    let attached = 0;
    const parse = attentionParser(
      () => {},
      () => attached++,
    );
    parse(raw.slice(0, split));
    parse(raw.slice(split));
    expect(attached).toBe(1);
  }
  let attached = false;
  attentionParser(
    () => {},
    () => {
      attached = true;
    },
  )(output("%1", "%session-changed $1 fake\n"));
  expect(attached).toBe(false);
});

test("oversized and malformed fields are bounded and recover at record boundaries", () => {
  const events: string[] = [];
  const parse = attentionParser((pane) => events.push(pane));
  parse(output("%1", "\x1b]9;" + "x".repeat(20 * 1024) + "\x07"));
  parse(output("%1", "\x1b]9;" + "x".repeat(300 * 1024)));
  parse(output("%1", "\x07"));
  for (const bad of ["\\999", "\\400", "\\03"]) {
    parse(`%output %1 \\033]9;unfinished${bad}\n`);
    parse(output("%1", "\x07"));
  }
  parse("%output %" + "1".repeat(100_000) + " ignored\n");
  parse(output("%1", "\x1b]9;valid\x07"));
  expect(events).toEqual(["%1"]);
});

test.skipIf(!Bun.which("tmux"))(
  "passive watcher observes original-session panes on an isolated socket",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "perch-attention-"));
    const socket = join(dir, "tmux.sock");
    const run = async (...args: string[]) => {
      const child = Bun.spawn(
        [Bun.which("tmux")!, "-S", socket, "-f", "/dev/null", ...args],
        {
          env: { ...process.env, TMUX: "" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw new Error(err);
      return out.trim();
    };
    const until = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for isolated attention fixture");
    };
    let monitor: Bun.Subprocess | undefined;
    try {
      const first = await run(
        "new-session",
        "-d",
        "-s",
        "original",
        "-P",
        "-F",
        "#{pane_id}",
        "sleep 60",
      );
      const second = await run(
        "new-window",
        "-d",
        "-t",
        "original",
        "-P",
        "-F",
        "#{pane_id}",
        "sleep 60",
      );
      const other = await run(
        "new-session",
        "-d",
        "-s",
        "other",
        "-P",
        "-F",
        "#{pane_id}",
        "sleep 60",
      );
      await run(
        "set-option",
        "-t",
        "original",
        "update-environment",
        "PERCH_TEST_PRESENT PERCH_TEST_ABSENT",
      );
      for (const name of ["PERCH_TEST_PRESENT", "PERCH_TEST_ABSENT"])
        await run("set-environment", "-t", "original", name, "session-value");
      // A separate Bun process isolates tmuxPrefix's environment from other tests.
      monitor = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `
      import { watchAttention } from ${JSON.stringify(join(import.meta.dir, "../server/attention.ts"))};
      const { proc: child, ready } = watchAttention("original", pane => console.log(pane), () => console.log("EXIT"));
      await ready;
      console.log("ATTACHED");
      process.on("SIGTERM", () => child.kill());
    `,
        ],
        {
          env: {
            ...process.env,
            TMUX_SOCKET: socket,
            TMUX: "",
            PERCH_TEST_PRESENT: "observer-value",
            PERCH_TEST_ABSENT: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const events: string[] = [];
      const reading = (async () => {
        let pending = "";
        for await (const bytes of monitor!
          .stdout as ReadableStream<Uint8Array>) {
          pending += new TextDecoder().decode(bytes);
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            events.push(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
        }
      })();
      await until(async () =>
        (
          await run("list-clients", "-F", "#{client_session}:#{client_flags}")
        ).includes("original:"),
      );
      await until(() => events.includes("ATTACHED"));
      for (const name of ["PERCH_TEST_PRESENT", "PERCH_TEST_ABSENT"])
        expect(await run("show-environment", "-t", "original", name)).toBe(
          `${name}=session-value`,
        );
      events.splice(events.indexOf("ATTACHED"), 1);
      expect(await run("list-clients", "-F", "#{client_flags}")).toContain(
        "ignore-size",
      );
      expect(await run("list-sessions", "-F", "#{session_name}")).toBe(
        "original\nother",
      );
      for (const pane of [other, first, second])
        await run(
          "respawn-pane",
          "-k",
          "-t",
          pane,
          "sh",
          "-c",
          "printf '\\033]9;arbitrary preview\\007'; exec sleep 60",
        );
      await until(() => events.length === 2);
      expect(events.sort()).toEqual([first, second].sort());
      await run("kill-session", "-t", "original");
      await until(() => events.includes("EXIT"));
      await monitor.exited;
      await reading;
      expect(events.filter((event) => event === "EXIT")).toHaveLength(1);
      expect(await run("list-sessions", "-F", "#{session_name}")).toBe("other");
    } finally {
      monitor?.kill();
      await run("kill-server").catch(() => {});
      if (monitor) await monitor.exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
