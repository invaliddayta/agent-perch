import { expect, test } from "bun:test";

test("shell cache retirement preserves speech and unrelated caches without intercepting requests", async () => {
  const handlers: Record<
    string,
    (event: { waitUntil(promise: Promise<unknown>): void }) => void
  > = {};
  const deleted: string[] = [];
  let waiting: Promise<unknown> = Promise.resolve();
  let skipped = false;
  let claimed = false;
  new Function(
    "self",
    "caches",
    await Bun.file(new URL("../public/sw.js", import.meta.url)).text(),
  )(
    {
      addEventListener: (name: string, handler: (typeof handlers)[string]) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {
        skipped = true;
      },
      clients: {
        claim: async () => {
          claimed = true;
        },
      },
    },
    {
      keys: async () => [
        "agent-watch-shell-v1",
        "agent-watch-shell-v0",
        "perch-speech-v1",
        "unrelated",
      ],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    },
  );
  const event = {
    waitUntil: (promise: Promise<unknown>) => {
      waiting = promise;
    },
  };
  handlers.install!(event);
  await waiting;
  handlers.activate!(event);
  await waiting;
  expect(skipped).toBe(true);
  expect(claimed).toBe(true);
  expect(deleted).toEqual(["agent-watch-shell-v1", "agent-watch-shell-v0"]);
  expect(handlers.fetch).toBeUndefined();
});
