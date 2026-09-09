import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let pending: Promise<unknown> = Promise.resolve();

export function storeImage(
  bytes: Uint8Array,
  mime: string,
  stateDir: string,
): Promise<string> {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const extension =
    mime === "image/png" &&
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : mime === "image/jpeg" &&
          prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? "jpg"
        : mime === "image/webp" &&
            prefix.toString("ascii", 0, 4) === "RIFF" &&
            prefix.toString("ascii", 8, 12) === "WEBP"
          ? "webp"
          : mime === "image/gif" && /^GIF8[79]a/.test(prefix.toString("ascii"))
            ? "gif"
            : undefined;
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    return Promise.reject(
      new Error("Images must be between 1 byte and 10 MiB."),
    );
  if (!extension)
    return Promise.reject(
      new Error(
        "Paste a PNG, JPEG, WebP, or GIF image with matching file contents.",
      ),
    );
  const operation = pending.then(async () => {
    const directory = join(stateDir, "images");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(entry.name)
      )
        continue;
      const file = join(directory, entry.name);
      const info = await stat(file);
      if (info.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await unlink(file);
      else total += info.size;
    }
    if (total + bytes.length > 100 * 1024 * 1024)
      throw new Error(
        "Image storage is full (100 MiB). Older uploads expire on the next upload after 24 hours.",
      );
    const path = join(directory, `${crypto.randomUUID()}.${extension}`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return path;
  });
  pending = operation.catch(() => {});
  return operation;
}
