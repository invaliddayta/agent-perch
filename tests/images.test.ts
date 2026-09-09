import { expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  stat,
  readFile,
  utimes,
  writeFile,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_IMAGE_BYTES, storeImage } from "../server/images";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
test("image uploads use private generated paths, expire only managed files, and enforce limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-images-"));
  try {
    const path = await storeImage(png, "image/png", dir);
    expect(path).toMatch(/\/images\/[a-f0-9-]{36}\.png$/);
    expect(await readFile(path)).toEqual(png);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "images"))).mode & 0o777).toBe(0o700);
    await expect(storeImage(png, "image/jpeg", dir)).rejects.toThrow(
      "matching",
    );
    await expect(
      storeImage(Buffer.from("<svg/>"), "image/svg+xml", dir),
    ).rejects.toThrow("PNG");
    await expect(
      storeImage(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png", dir),
    ).rejects.toThrow("10 MiB");
    const untouched = join(dir, "images", "user-file.txt");
    await writeFile(untouched, "keep");
    await utimes(path, 0, 0);
    await utimes(untouched, 0, 0);
    const next = await storeImage(png, "image/png", dir);
    expect(next).not.toBe(path);
    await expect(stat(path)).rejects.toThrow();
    expect(await readFile(untouched, "utf8")).toBe("keep");
    await truncate(next, 100 * 1024 * 1024);
    await expect(storeImage(png, "image/png", dir)).rejects.toThrow(
      "storage is full",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
