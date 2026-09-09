import { expect, test } from "bun:test";
import { terminalEscape, terminalFullscreen } from "../src/keyboard";

test("Escape is consumed once, including toolbar/body focus; a held key does not spam the agent", () => {
  let sent = 0,
    prevented = 0,
    stopped = 0;
  const event = {
    key: "Escape",
    target: null,
    preventDefault: () => prevented++,
    stopImmediatePropagation: () => stopped++,
  } as unknown as KeyboardEvent;
  expect(terminalEscape(event, () => sent++)).toBe(true);
  expect([sent, prevented, stopped]).toEqual([1, 1, 1]);
  expect(terminalEscape({ ...event, repeat: true }, () => sent++)).toBe(true);
  expect([sent, prevented, stopped]).toEqual([1, 2, 2]);
  // A second distinct Escape press remains a second input (e.g. OpenCode's double Escape).
  terminalEscape(event, () => sent++);
  expect(sent).toBe(2);
});

test("modified keys, handled events and IME Escape remain with their owner", () => {
  for (const overrides of [
    { key: "a" },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true },
  ]) {
    const event = { key: "Escape", ...overrides } as unknown as KeyboardEvent;
    expect(
      terminalEscape(event, () => {
        throw new Error("Unexpected terminal input");
      }),
    ).toBe(false);
  }
});

test("editing controls and dialogs own Escape, except xterm's input textarea", () => {
  for (const terminal of [false, true]) {
    let sent = 0;
    const event = {
      key: "Escape",
      preventDefault() {},
      stopImmediatePropagation() {},
      target: {
        closest: (selector: string) =>
          selector === ".terminal-canvas" ? terminal : true,
      },
    } as unknown as KeyboardEvent;
    expect(terminalEscape(event, () => sent++)).toBe(terminal);
    expect(sent).toBe(Number(terminal));
  }
});

function fullscreenFixture() {
  const calls: string[] = [];
  const doc = {
    fullscreenElement: null as HTMLElement | null,
    documentElement: {
      requestFullscreen: async () => {
        calls.push("fullscreen");
        doc.fullscreenElement = {} as HTMLElement;
      },
    },
    exitFullscreen: async () => {
      calls.push("exit");
      doc.fullscreenElement = null;
    },
  };
  const keyboard = {
    lock: async (keys: string[]) => {
      calls.push("lock");
      expect(keys).toContain("Escape");
      expect(keys).not.toContain("KeyV");
    },
    unlock: () => {
      calls.push("unlock");
    },
  };
  return {
    doc: doc as Pick<
      Document,
      "fullscreenElement" | "documentElement" | "exitFullscreen"
    >,
    keyboard,
    calls,
  };
}

test("fullscreen starts keyboard capture in the click before requesting fullscreen and releases it on exit", async () => {
  const { doc, keyboard, calls } = fullscreenFixture();
  await terminalFullscreen(doc, keyboard);
  expect(calls).toEqual(["lock", "fullscreen"]);
  await terminalFullscreen(doc, keyboard);
  expect(calls).toEqual(["lock", "fullscreen", "unlock", "exit"]);
});

test("unsupported capture never enters fullscreen, including touch devices with hardware keyboards", async () => {
  const { doc, calls } = fullscreenFixture();
  await expect(terminalFullscreen(doc)).rejects.toThrow(
    "cannot capture Escape",
  );
  expect(calls).toEqual([]);
});

test("denied keyboard permission waits for late fullscreen entry, then exits safely", async () => {
  const { doc, keyboard, calls } = fullscreenFixture();
  keyboard.lock = async () => {
    throw new Error("Denied");
  };
  let enter!: () => void;
  doc.documentElement.requestFullscreen = () =>
    new Promise<void>((resolve) => {
      enter = () => {
        Object.assign(doc, { fullscreenElement: {} });
        resolve();
      };
    });
  const result = terminalFullscreen(doc, keyboard);
  await Bun.sleep(0);
  expect(calls).toEqual([]);
  enter();
  await expect(result).rejects.toThrow("capture was not granted");
  expect(calls).toEqual(["unlock", "exit"]);
  expect(doc.fullscreenElement).toBeNull();
});

test("fullscreen rejection and synchronous API failure release keyboard capture", async () => {
  for (const synchronous of [false, true]) {
    const { doc, keyboard, calls } = fullscreenFixture();
    doc.documentElement.requestFullscreen = () => {
      if (synchronous) throw new Error("Unavailable");
      return Promise.reject(new Error("Unavailable"));
    };
    await expect(terminalFullscreen(doc, keyboard)).rejects.toThrow(
      "capture was not granted",
    );
    expect(calls).toEqual(["lock", "unlock"]);
  }
});

test("leaving fullscreen while permission is pending does not retain a late keyboard lock", async () => {
  const { doc, keyboard, calls } = fullscreenFixture();
  let grant!: () => void;
  keyboard.lock = () =>
    new Promise<void>((resolve) => {
      grant = resolve;
    });
  const pending = terminalFullscreen(doc, keyboard);
  await doc.exitFullscreen();
  grant();
  await pending;
  expect(calls).toEqual(["fullscreen", "exit", "unlock"]);
});
