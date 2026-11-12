import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd().endsWith("/dist") ? join(process.cwd(), "..") : process.cwd();
const installer = join(root, "install.sh");
async function home() { const dir = await mkdtemp(join(tmpdir(), "persistara-install-")); await chmod(dir, 0o700); return dir; }
const env = (h: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: h, SHELL: "/bin/bash", ...extra });
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("install.sh (no network: syntax, dry run and uninstall safety)", () => {
  it("is valid bash and executable", async () => {
    await exec("bash", ["-n", installer]);
    assert.ok(((await stat(installer)).mode & 0o111) !== 0, "executable bit");
    const text = await readFile(installer, "utf8");
    assert.ok(text.trimEnd().endsWith('main "$@"'), "everything runs from main() so a truncated download executes nothing");
    assert.ok(!/\bsudo\b/.test(text.replace(/^#.*$/gm, "")), "never calls sudo");
  });

  it("dry run changes nothing and reports each planned step", async () => {
    const h = await home();
    try {
      const { stdout } = await exec("bash", [installer, "--dry-run"], { env: env(h, { PERSISTARA_REPO: "file:///nonexistent/repo" }) });
      assert.ok(stdout.includes("Dry run complete; nothing was changed."));
      for (const step of ["git -C", "install --frozen-lockfile", ".local/bin/persistara", ".bashrc", ".persistara-workspace"]) assert.ok(stdout.includes(step), step);
      assert.deepEqual(await readdir(h), [], "the home directory is untouched");
    } finally { await rm(h, { recursive: true, force: true }); }
  });

  it("refuses unsafe paths, unknown options and a foreign command or directory", async () => {
    const h = await home();
    try {
      await assert.rejects(exec("bash", [installer, "--dry-run"], { env: env(h, { PERSISTARA_HOME: "relative/dir" }) }), /absolute path/);
      await assert.rejects(exec("bash", [installer, "--dry-run"], { env: env(h, { PERSISTARA_INSTALL_DIR: `${h}/a b` }) }), /will not embed/);
      await assert.rejects(exec("bash", [installer, "--nope"], { env: env(h) }), /unknown option/);
      const foreign = join(h, "app"); await mkdir(foreign); await writeFile(join(foreign, "keep.txt"), "mine");
      await assert.rejects(exec("bash", [installer], { env: env(h, { PERSISTARA_INSTALL_DIR: foreign, PERSISTARA_REPO: "file:///nonexistent/repo" }) }), /not created by this installer/);
      assert.equal(await readFile(join(foreign, "keep.txt"), "utf8"), "mine");
      await mkdir(join(h, "bin")); await writeFile(join(h, "bin", "persistara"), "#!/bin/sh\necho someone else's tool\n", { mode: 0o755 });
      await assert.rejects(exec("bash", [installer], { env: env(h, { PERSISTARA_BIN_DIR: join(h, "bin"), PERSISTARA_INSTALL_DIR: join(h, "new-app"), PERSISTARA_REPO: "file:///nonexistent/repo" }) }), /not managed by this installer|nonexistent|fatal/);
      assert.ok((await readFile(join(h, "bin", "persistara"), "utf8")).includes("someone else's tool"));
    } finally { await rm(h, { recursive: true, force: true }); }
  });

  it("uninstall removes only what it created and never touches the private workspace", async () => {
    const h = await home();
    try {
      const app = join(h, "share", "app"), bin = join(h, "bin"), ws = join(h, "ws");
      await mkdir(app, { recursive: true }); await writeFile(join(app, ".persistara-install"), "ref=main\n"); await writeFile(join(app, "file"), "x");
      await mkdir(bin); await writeFile(join(bin, "persistara"), "#!/bin/sh\n# persistara-managed-shim\nexec true\n", { mode: 0o755 });
      await mkdir(join(ws, ".persistara", "keys"), { recursive: true }); await writeFile(join(ws, ".env"), "NEARAI_API_KEY=SECRET"); await writeFile(join(ws, ".persistara", "keys", "near-runtime.key"), "KEY");
      await writeFile(join(h, ".bashrc"), 'echo before\n# >>> persistara >>>\nexport PATH="/x:$PATH"\n# <<< persistara <<<\necho after\n');
      const { stdout } = await exec("bash", [installer, "--uninstall"], { env: env(h, { PERSISTARA_INSTALL_DIR: app, PERSISTARA_BIN_DIR: bin, PERSISTARA_HOME: ws }) });
      assert.ok(stdout.includes("workspace") && stdout.includes("NOT touched"));
      assert.ok(!(await exists(app)) && !(await exists(join(bin, "persistara"))));
      assert.equal(await readFile(join(h, ".bashrc"), "utf8"), "echo before\necho after\n", "only the marked block is removed");
      assert.equal(await readFile(join(ws, ".env"), "utf8"), "NEARAI_API_KEY=SECRET"); assert.equal(await readFile(join(ws, ".persistara", "keys", "near-runtime.key"), "utf8"), "KEY");
      // a directory without the marker is never deleted, even by --uninstall
      const foreign = join(h, "other"); await mkdir(foreign); await writeFile(join(foreign, "keep"), "mine");
      await exec("bash", [installer, "--uninstall"], { env: env(h, { PERSISTARA_INSTALL_DIR: foreign, PERSISTARA_BIN_DIR: bin, PERSISTARA_HOME: ws }) });
      assert.equal(await readFile(join(foreign, "keep"), "utf8"), "mine");
    } finally { await rm(h, { recursive: true, force: true }); }
  });
});
