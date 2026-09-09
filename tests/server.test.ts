import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allowedRequest } from "../server/security";
import { validName, projectPath } from "../server/tmux";

const dirs: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "perch-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("network boundary", () => {
  const origin = "https://host.example.ts.net";
  const origins = new Set([origin]);
  const request = (headers: Record<string, string>) =>
    new Request(origin + "/api/sessions", {
      headers: { Host: new URL(origin).host, ...headers },
    });
  test("allows same-origin mutation with required header", () => {
    expect(
      allowedRequest(
        request({ Origin: origin, "X-Agent-Watch": "1" }),
        origins,
        true,
      ),
    ).toBe(true);
  });
  test("denies cross-origin and null-origin mutation", () => {
    for (const Origin of ["https://attacker.invalid", "null", ""])
      expect(
        allowedRequest(
          request({ Origin, "X-Agent-Watch": "1" }),
          origins,
          true,
        ),
      ).toBe(false);
  });
  test("denies missing header, rebinding Host, and cross-site fetches", () => {
    expect(allowedRequest(request({ Origin: origin }), origins, true)).toBe(
      false,
    );
    expect(allowedRequest(request({ Host: "attacker.invalid" }), origins)).toBe(
      false,
    );
    expect(
      allowedRequest(request({ "Sec-Fetch-Site": "cross-site" }), origins),
    ).toBe(false);
  });
  test("allows installed-app entry navigation without opening API or socket access", () => {
    for (const destination of ["document", "empty"]) {
      const navigation = {
        Host: new URL(origin).host,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": destination,
      };
      for (const path of ["/", "/index.html", "/?source=installed"])
        expect(
          allowedRequest(
            new Request(origin + path, { headers: navigation }),
            origins,
          ),
        ).toBe(true);
      for (const path of ["/api/sessions", "/terminal", "/models/config.json"])
        expect(
          allowedRequest(
            new Request(origin + path, { headers: navigation }),
            origins,
          ),
        ).toBe(false);
      for (const override of [
        { Host: "attacker.invalid" },
        { "Sec-Fetch-Mode": "cors" },
        { "Sec-Fetch-Dest": "iframe" },
      ])
        expect(
          allowedRequest(
            new Request(origin, { headers: { ...navigation, ...override } }),
            origins,
          ),
        ).toBe(false);
      expect(
        allowedRequest(
          new Request(origin, { method: "POST", headers: navigation }),
          origins,
          true,
        ),
      ).toBe(false);
      expect(
        allowedRequest(
          request({
            Origin: "null",
            "Sec-Fetch-Site": "cross-site",
            "X-Agent-Watch": "1",
          }),
          origins,
          true,
        ),
      ).toBe(false);
    }
  });
});

test("directory paths support absolute, relative, home and symlink targets without a project boundary", async () => {
  const dir = await temporary();
  const outside = await temporary();
  await mkdir(join(dir, "inside"));
  await symlink(outside, join(dir, "linked"));
  expect(await projectPath(dir, "inside")).toBe(join(dir, "inside"));
  expect(await projectPath(dir, outside)).toBe(outside);
  expect(await projectPath(dir, "linked")).toBe(outside);
  expect(await projectPath(dir, `../${outside.split("/").pop()}`)).toBe(
    outside,
  );
  expect(await projectPath(dir, "~")).toBe(
    await projectPath(dir, process.env.HOME!),
  );
  expect(await projectPath(dir, "~/.")).toBe(await projectPath(dir, "~"));
  expect(await projectPath(dir, "~//.")).toBe(await projectPath(dir, "~"));
});

test("new directories require explicit creation and paths stay literal", async () => {
  const dir = await temporary();
  const input = "new folder/$(touch injected); literal";
  await expect(projectPath(dir, input)).rejects.toThrow("does not exist");
  expect(await projectPath(dir, input, true)).toBe(join(dir, input));
  expect(await Bun.file(join(dir, "injected")).exists()).toBe(false);
  await mkdir(join(dir, " spaces "));
  expect(await projectPath(dir, " spaces ")).toBe(join(dir, " spaces "));
  await writeFile(join(dir, "file"), "not a directory");
  for (const create of [false, true]) {
    await expect(projectPath(dir, "file", create)).rejects.toThrow(
      "not a directory",
    );
    for (const input of [
      "",
      "  ",
      "new\nfolder",
      "new\tfolder",
      "new\0folder",
      "~someone/project",
    ])
      await expect(projectPath(dir, input, create)).rejects.toThrow();
  }
  await mkdir(join(dir, "bad\tpath"));
  await symlink(join(dir, "bad\tpath"), join(dir, "bad-link"));
  await expect(projectPath(dir, "bad-link")).rejects.toThrow(
    "control characters",
  );
});

test("session names remain safe tmux identifiers", () => {
  for (const name of [
    "a;touch bad",
    "-arg",
    "foo.bar",
    "",
    "a\nb",
    "__agent_watch_view_x",
  ])
    expect(validName(name)).toBe(false);
  expect(validName("agent-watch_1")).toBe(true);
});
