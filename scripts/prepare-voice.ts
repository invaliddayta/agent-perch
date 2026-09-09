import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_FILES,
  MODEL_PATH,
  MODEL_URL,
  RUNTIME_PATH,
  SPEECH_MODEL,
  SPEECH_REVISION,
  SPEECH_RUNTIME,
} from "../src/speech-model";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const modelDir = join(publicDir, MODEL_PATH);
const runtimeDir = join(publicDir, RUNTIME_PATH);
const marker = join(modelDir, "ready.json");
await mkdir(modelDir, { recursive: true });
await rm(marker, { force: true });

let total = 0;
for (const [file, expected] of Object.entries(MODEL_FILES)) {
  const destination = join(modelDir, file);
  const response = await fetch(`${MODEL_URL}/${file}`, {
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Failed to download ${file}: HTTP ${response.status}`);
  const temporary = `${destination}.download`;
  try {
    await Bun.write(temporary, await response.arrayBuffer());
    const { size } = await stat(temporary);
    if (size !== expected)
      throw new Error(
        `Incomplete ${file}: expected ${expected} bytes, received ${size}`,
      );
    await rename(temporary, destination);
    total += size;
    console.log(`${file}: ${(size / 1024 ** 2).toFixed(2)} MiB`);
  } finally {
    await rm(temporary, { force: true });
  }
}

const runtimeSource = dirname(
  fileURLToPath(import.meta.resolve("@moonshine-ai/moonshine-wasm")),
);
await cp(runtimeSource, runtimeDir, { recursive: true });
const license = await fetch(
  "https://raw.githubusercontent.com/moonshine-ai/moonshine/234f60faa0eb388b01cdf7e60aca232af37aefda/LICENSE",
);
if (!license.ok)
  throw new Error("Could not fetch the pinned Moonshine license");
await Bun.write(join(runtimeDir, "LICENSE"), await license.text());
for await (const file of new Bun.Glob("**/*").scan({
  cwd: runtimeDir,
  onlyFiles: true,
}))
  total += (await stat(join(runtimeDir, file))).size;
await Bun.write(
  marker,
  JSON.stringify(
    {
      model: SPEECH_MODEL,
      revision: SPEECH_REVISION,
      runtime: SPEECH_RUNTIME,
      language: "en",
      dtype: "q8",
      bytes: total,
      preparedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `English voice assets ready: ${(total / 1024 ** 2).toFixed(2)} MiB total`,
);
