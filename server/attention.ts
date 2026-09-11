import { tmuxPrefix } from "./tmux";

// Keep protocol state, never notification previews or terminal history.
function notificationParser(onAttention: () => void, depth = 0) {
  let state = "ground";
  let prefix = 0;
  let length = 0;
  let firstIsFour = false;
  let progress = false;
  let notify = false;
  let inner: ReturnType<typeof notificationParser> | undefined;
  const finish = () => {
    state = "ground";
    if (notify && length > 0 && length <= 16 * 1024 && !progress) onAttention();
  };
  return (char: string) => {
    switch (state) {
      case "ground":
        if (char === "\x1b") state = "escape";
        break;
      case "escape":
        state = "ground";
        if (char === "]") {
          state = "osc9";
          notify = false;
          length = 0;
          firstIsFour = progress = false;
        } else if (char === "P") {
          state = "dcs-prefix";
          prefix = 0;
        } else if ("_^X".includes(char)) state = "string";
        else if (char === "\x1b") state = "escape";
        break;
      case "osc9":
      case "osc-separator":
      case "osc":
        if (char === "\x07") finish();
        else if (char === "\x1b") state = "osc-escape";
        else if (state === "osc9") {
          state = char === "9" ? "osc-separator" : "osc";
        } else if (state === "osc-separator") {
          notify = char === ";";
          state = "osc";
        } else if (notify) {
          length = Math.min(length + 1, 16 * 1024 + 1);
          if (length === 1) firstIsFour = char === "4";
          if (length === 2) progress = firstIsFour && char === ";";
        }
        break;
      case "osc-escape":
        if (char === "\\") finish();
        else {
          notify = false;
          state = char === "\x07" ? "ground" : "osc";
        }
        break;
      case "dcs-prefix":
        if (char === "tmux;"[prefix] && depth < 2) {
          if (++prefix === 5) {
            inner = notificationParser(onAttention, depth + 1);
            state = "wrapped";
          }
        } else state = char === "\x1b" ? "string-escape" : "string";
        break;
      case "wrapped":
        if (char === "\x1b") state = "wrapped-escape";
        else inner!(char);
        break;
      case "wrapped-escape":
        if (char === "\x1b") {
          inner!(char);
          state = "wrapped";
        } else {
          inner = undefined;
          state = char === "\\" ? "ground" : "string";
        }
        break;
      case "string":
        if (char === "\x1b") state = "string-escape";
        break;
      case "string-escape":
        state =
          char === "\\"
            ? "ground"
            : char === "\x1b"
              ? "string-escape"
              : "string";
        break;
    }
  };
}

// Accept raw tmux control-mode stdout, including octal-escaped %output fields.
// Only pane IDs escape this parser; OSC 9 text is untrusted, not an event type.
export function attentionParser(
  onAttention: (paneId: string) => void,
  onAttached?: () => void,
) {
  const panes = new Map<string, ReturnType<typeof notificationParser>>();
  let header = "";
  let pane: string | undefined;
  let parse: ReturnType<typeof notificationParser> | undefined;
  let octal = "";
  let decoded = 0;
  let dropping = false;
  return (chunk: string) => {
    for (const char of chunk) {
      if (char === "\n") {
        if (octal && pane) panes.delete(pane);
        header = octal = "";
        pane = undefined;
        parse = undefined;
        decoded = 0;
        dropping = false;
        continue;
      }
      if (dropping) continue;
      if (!parse) {
        header += char;
        if ("%session-changed ".startsWith(header)) {
          if (header === "%session-changed ") {
            onAttached?.();
            dropping = true;
          }
          continue;
        }
        if (header.length <= 8) {
          dropping = !"%output ".startsWith(header);
        } else if (char === " ") {
          const match = /^%output (%\d{1,16}) $/.exec(header);
          if (!match) {
            dropping = true;
            continue;
          }
          pane = match[1];
          parse = panes.get(pane);
          if (!parse) {
            if (panes.size >= 1024) panes.delete(panes.keys().next().value!);
            const id = pane;
            parse = notificationParser(() => onAttention(id));
            panes.set(pane, parse);
          }
          header = "";
        } else if (header.length > 26) dropping = true;
        continue;
      }
      let value = char;
      if (octal) {
        octal += char;
        if (!/^[0-7]$/.test(char) || (octal.length === 2 && char > "3")) {
          dropping = true;
          panes.delete(pane!);
          continue;
        }
        if (octal.length < 4) continue;
        value = String.fromCharCode(parseInt(octal.slice(1), 8));
        octal = "";
      } else if (char === "\\") {
        octal = char;
        continue;
      }
      if (++decoded > 256 * 1024) {
        dropping = true;
        panes.delete(pane!);
      } else parse(value);
    }
  };
}

export function watchAttention(
  session: string,
  onAttention: (paneId: string) => void,
  onExit: () => void,
) {
  // Attach to the original session, not a grouped viewer. Never write stdin or
  // change notify/pipe-pane hooks. The owner manages lifecycle; no restarts here.
  // -E preserves the session environment instead of importing the observer's.
  const child = Bun.spawn(
    [
      ...tmuxPrefix,
      "-C",
      "attach-session",
      "-E",
      "-f",
      "ignore-size",
      "-t",
      session,
    ],
    {
      env: { ...process.env, TMUX: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Native notification observer did not attach.")),
      1500,
    );
    const parse = attentionParser(onAttention, () => {
      clearTimeout(timer);
      resolve();
    });
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const bytes of child.stdout)
          parse(decoder.decode(bytes, { stream: true }));
      } catch {
        child.kill();
      } finally {
        clearTimeout(timer);
        reject(new Error("Native notification observer exited."));
        await child.exited;
        onExit();
      }
    })().catch(() => {});
  });
  void ready.catch(() => child.kill());
  return { proc: child, ready };
}
