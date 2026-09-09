import { expect, test } from "bun:test";
import { isTerminalResponse } from "../src/terminal-protocol";

test("terminal handshakes are recognized without allowing keyboard commands through a lock", () => {
  for (const response of [
    "\x1b[?1;2c",
    "\x1b[2;4R",
    "\x1b[0n",
    "\x1b]11;rgb:1111/1515/1212\x1b\\",
  ])
    expect(isTerminalResponse(response)).toBe(true);
  for (const input of [
    "echo unsafe\r",
    "\x03",
    "\x1b[?1;2cecho unsafe\r",
    "\x1b[200~echo unsafe\x1b[201~",
  ])
    expect(isTerminalResponse(input)).toBe(false);
});
