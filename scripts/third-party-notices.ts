import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Include license files from the locked build dependencies as well as runtime
// dependencies. This is deliberately inclusive; the model weights are not shipped.
export async function thirdPartyNotices(root: string): Promise<string> {
  const notices: string[] = [
    "Agent Perch third-party notices\n\nOptional speech models/runtime assets are not included in this distribution.",
  ];
  async function packages(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        await packages(path);
        continue;
      }
      const manifest = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      );
      const files = (await readdir(path))
        .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
        .sort();
      notices.push(
        `\n---\n${manifest.name}@${manifest.version}\nLicense: ${JSON.stringify(manifest.license || "See package distribution")}\n`,
      );
      for (const file of files)
        notices.push(`${file}\n${await readFile(join(path, file), "utf8")}`);
      if (
        await stat(join(path, "node_modules"))
          .then((s) => s.isDirectory())
          .catch(() => false)
      )
        await packages(join(path, "node_modules"));
    }
  }
  await packages(join(root, "node_modules"));
  notices.push(
    "\n---\nProggy Clean font\n" +
      (await readFile(join(root, "public/fonts/LICENSE.txt"), "utf8")),
  );
  return notices.join("\n");
}

if (import.meta.main)
  await Bun.write(
    process.argv[2] || "THIRD_PARTY_NOTICES.txt",
    await thirdPartyNotices(process.cwd()),
  );
