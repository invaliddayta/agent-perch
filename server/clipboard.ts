import { tmux, tmuxPrefix } from "./tmux";

// Write-only OSC 52 support. Queries never receive a response or expose client clipboard contents.
export function clipboardParser(onText: (text: string) => void) {
  let buffer = "";
  let previous = "";
  let previousAt = 0;
  return (chunk: string) => {
    buffer += chunk;
    while (buffer.length) {
      const start = buffer.indexOf("\x1b]52;");
      if (start < 0) {
        buffer = buffer.slice(-5);
        return;
      }
      buffer = buffer.slice(start);
      const bell = buffer.indexOf("\x07");
      const st = buffer.indexOf("\x1b\\");
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (buffer.length > 256 * 1024) buffer = "";
        return;
      }
      const data = buffer.slice(5, end);
      buffer = buffer.slice(end + (end === st ? 2 : 1));
      const match = /^(?:c)?;([A-Za-z0-9+/]+={0,2})$/.exec(data);
      if (!match || match[1].length > 256 * 1024 || match[1].length % 4)
        continue;
      try {
        const bytes = Buffer.from(match[1], "base64");
        if (bytes.length > 128 * 1024) continue;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text || (text === previous && Date.now() - previousAt < 1000))
          continue;
        previous = text;
        previousAt = Date.now();
        onText(text);
      } catch {}
    }
  };
}

export function watchViewer(
  viewer: string,
  onPane: (pane: string, initial: boolean) => void,
  onText: (pane: string, text: string) => void,
  onExit: () => void,
) {
  // Control mode observes raw pane output before tmux strips OSC 52. No global options or user pipe-pane hooks are changed.
  // Never write to its stdin. A tmux read-only client can also block our separate, explicitly targeted CLI commands.
  const child = Bun.spawn(
    [...tmuxPrefix, "-C", "attach-session", "-f", "ignore-size", "-t", viewer],
    {
      env: { ...process.env, TMUX: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  let window: string | undefined;
  let pane = "";
  let ready = false;
  let stopped = false;
  let revision = 0;
  let parse = clipboardParser((text) => {
    if (pane) onText(pane, text);
  });
  const timer = setTimeout(() => child.kill(), 1500);
  const select = (next: string) => {
    pane = next;
    // Partial clipboard sequences must not survive a pane round trip.
    parse = clipboardParser((text) => {
      if (pane) onText(pane, text);
    });
    if (ready || pane) {
      onPane(pane, !ready);
      ready = true;
      clearTimeout(timer);
    }
  };
  const refresh = async () => {
    const version = ++revision;
    select("");
    const result = await tmux(
      "display-message",
      "-p",
      "-t",
      viewer,
      "#{window_id} #{pane_id}",
    );
    if (stopped || version !== revision) return;
    const match = /^(@\d+) (%\d+)$/.exec(result);
    if (!match) throw new Error("Viewer no longer has a pane");
    window = match[1];
    select(match[2]);
  };
  void (async () => {
    let line = "";
    let dropping = false;
    const decoder = new TextDecoder();
    for await (const bytes of child.stdout) {
      line += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = line.indexOf("\n")) !== -1) {
        const row = line.slice(0, end);
        line = line.slice(end + 1);
        if (dropping || row.length > 1024 * 1024) {
          dropping = false;
          continue;
        }
        const attached = /^%session-changed (\$\d+) /.exec(row);
        const changed = /^%session-window-changed (\$\d+) (@\d+)$/.exec(row);
        const active = /^%window-pane-changed (@\d+) (%\d+)$/.exec(row);
        if (attached) {
          if (attached[1] !== viewer)
            throw new Error("Viewer observer changed session");
          void refresh().catch(() => child.kill());
        } else if (changed?.[1] === viewer) {
          window = changed[2];
          void refresh().catch(() => child.kill());
        } else if (active && (!window || active[1] === window)) {
          if (!window) void refresh().catch(() => child.kill());
          else {
            ++revision;
            select("");
            select(active[2]);
          }
        }
        const match = /^%output (%\d+) (.*)$/.exec(row);
        if (!match || match[1] !== pane) continue;
        parse(
          match[2].replace(/\\([0-7]{3})/g, (_, octal) =>
            String.fromCharCode(parseInt(octal, 8)),
          ),
        );
      }
      if (line.length > 1024 * 1024) {
        line = "";
        dropping = true;
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      stopped = true;
      clearTimeout(timer);
      child.kill();
      onExit();
    });
  return child;
}
