// Only terminal replies, never arbitrary keyboard input, may bypass the input lock.
export function isTerminalResponse(data: string) {
  return /^(?:\x1b\[[?>=]?[0-9;:]*[cnR]|\x1b\[\?[0-9;]+\$y|\x1b\](?:10|11|12);rgb:[0-9a-f/]+(?:\x07|\x1b\\))+$/i.test(
    data,
  );
}
