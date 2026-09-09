export type KeyboardLock = {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
};

// Called only while a terminal is selected and no Perch dialog is open.
export function terminalEscape(event: KeyboardEvent, send: () => void) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false;
  const target = event.target as HTMLElement | null;
  if (
    target?.closest?.(
      'dialog, [role="dialog"], input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ) &&
    !target.closest(".terminal-canvas")
  )
    return false;
  // Handle once, before xterm and browser defaults, including toolbar/body focus.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) send();
  return true;
}

export async function terminalFullscreen(
  doc: Pick<
    Document,
    "fullscreenElement" | "documentElement" | "exitFullscreen"
  >,
  keyboard?: KeyboardLock,
) {
  if (doc.fullscreenElement) {
    keyboard?.unlock();
    await doc.exitFullscreen();
    return;
  }
  if (!keyboard?.lock)
    throw new Error(
      "This browser cannot capture Escape in fullscreen. Use the page-sized terminal or the on-screen Esc key instead.",
    );
  try {
    // Start both requests in the click's user activation, before awaiting either permission.
    const lock = keyboard.lock([
      "Escape",
      "Tab",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Insert",
      "Delete",
      "Backspace",
      "KeyR",
      "KeyW",
      "KeyT",
      "KeyN",
      "KeyL",
      "KeyP",
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    ]);
    const fullscreen = (async () =>
      doc.documentElement.requestFullscreen({ navigationUI: "hide" }))();
    const results = await Promise.allSettled([lock, fullscreen]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Fullscreen keyboard capture was not granted. Allow keyboard capture in your browser, or use the page-sized terminal and on-screen Esc key.",
      );
    if (!doc.fullscreenElement) keyboard.unlock();
  } catch (error) {
    keyboard.unlock();
    // Wait for both requests above: a late fullscreen success must not leave Escape trapped.
    if (doc.fullscreenElement) await doc.exitFullscreen();
    throw error;
  }
}
