import { execFile } from "node:child_process";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createGitService({ database, getProjects, getConfig }) {
  async function status(worktreePath) {
    const cwd = await requireWorktree(worktreePath);
    const [branch, porcelain, recent] = await Promise.all([
      git(cwd, ["branch", "--show-current"]),
      // NUL-delimited output keeps filenames with spaces or quotes intact.
      git(cwd, ["status", "--porcelain=v1", "--branch", "-z"]),
      safeGit(cwd, ["log", "-8", "--pretty=format:%h%x09%an%x09%ar%x09%s"]),
    ]);
    const { header, files } = parsePorcelain(porcelain);
    return {
      branch,
      tracking: header.replace(/^## /, ""),
      files,
      stagedCount: files.filter((file) => file.index !== " " && file.index !== "?").length,
      unstagedCount: files.filter((file) => file.worktree !== " ").length,
      commits: recent.split("\n").filter(Boolean).map((line) => {
        const [hash, author, relativeTime, ...subject] = line.split("\t");
        return { hash, author, relativeTime, subject: subject.join("\t") };
      }),
    };
  }

  async function diff(worktreePath, filePath, staged = false) {
    const cwd = await requireWorktree(worktreePath);
    if (filePath) await requireChildPath(cwd, filePath);
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (staged) args.push("--cached");
    if (filePath) args.push("--", filePath);
    let output = await safeGit(cwd, args, { maxBuffer: 12 * 1024 * 1024 });
    if (!output && filePath) {
      const tracked = await safeGit(cwd, ["ls-files", "--error-unmatch", "--", filePath]);
      if (!tracked) output = await gitOutputOnFailure(cwd, ["diff", "--no-index", "--", "/dev/null", path.resolve(cwd, filePath)]);
    }
    return { diff: output };
  }

  async function stage(worktreePath, files) {
    const cwd = await requireWorktree(worktreePath);
    const validated = await validateFiles(cwd, files);
    await git(cwd, ["add", "--", ...validated]);
    database.audit("git.stage", { target: cwd, files: validated });
    return status(cwd);
  }

  async function unstage(worktreePath, files) {
    const cwd = await requireWorktree(worktreePath);
    const validated = await validateFiles(cwd, files);
    try { await git(cwd, ["restore", "--staged", "--", ...validated]); }
    catch { await git(cwd, ["rm", "--cached", "--", ...validated]); }
    database.audit("git.unstage", { target: cwd, files: validated });
    return status(cwd);
  }

  async function commit(worktreePath, message) {
    const cwd = await requireWorktree(worktreePath);
    if (!message?.trim()) throw httpError(400, "Commit message is required");
    const output = await git(cwd, ["commit", "-m", message.trim()], { maxBuffer: 8 * 1024 * 1024 });
    database.audit("git.commit", { target: cwd, message: message.trim() });
    return { output, status: await status(cwd) };
  }

  async function createWorktree({ projectId, branch, name, baseBranch = "HEAD" }) {
    const project = getProjects().find((item) => item.id === projectId);
    if (!project) throw httpError(404, "Project not found");
    if (!/^[A-Za-z0-9._/-]+$/.test(branch ?? "")) throw httpError(400, "Invalid branch name");
    const root = project.worktrees.find((item) => !item.isLinked)?.path ?? project.path;
    const directoryName = name?.trim() || `${project.name}-${branch.split("/").at(-1)}`;
    if (!/^[A-Za-z0-9._-]+$/.test(directoryName)) throw httpError(400, "Invalid worktree directory name");
    const destination = path.resolve(path.dirname(project.path), directoryName);
    await requireScanRoot(destination);
    if (await exists(destination)) throw httpError(409, "Destination already exists");
    await git(root, ["worktree", "add", "-b", branch, destination, baseBranch]);
    database.audit("git.worktree.created", { target: destination, projectId, branch, baseBranch });
    return { path: destination, branch };
  }

  async function removeWorktree({ projectId, worktreePath, confirmation }) {
    const project = getProjects().find((item) => item.id === projectId);
    const worktree = project?.worktrees.find((item) => item.path === worktreePath);
    if (!project || !worktree) throw httpError(404, "Worktree not found");
    if (!worktree.isLinked) throw httpError(400, "The primary worktree cannot be removed");
    if (confirmation !== worktreePath) throw httpError(400, "Exact worktree path confirmation is required");
    if (worktree.changedCount) throw httpError(409, "Worktree has uncommitted changes");
    await git(project.path, ["worktree", "remove", worktreePath]);
    database.audit("git.worktree.removed", { target: worktreePath, projectId });
    return { removed: true };
  }

  async function openInEditor(worktreePath, filePath, editor) {
    const cwd = await requireWorktree(worktreePath);
    const target = filePath ? await requireChildPath(cwd, filePath) : cwd;
    const configured = editor || database.getSettings().editor;
    const commands = {
      zed: ["zed", [target]],
      code: ["code", [target]],
      cursor: ["cursor", [target]],
      finder: ["open", ["-R", target]],
    };
    const [executable, args] = commands[configured] ?? commands.zed;
    const child = execFile(executable, args, { windowsHide: true }, () => {});
    child.unref?.();
    database.audit("editor.open", { target, editor: configured });
    return { opened: true, editor: configured, target };
  }

  async function context(worktreePath) {
    const cwd = await requireWorktree(worktreePath);
    const instructionFiles = [];
    for (const name of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]) {
      const target = path.join(cwd, name);
      if (await exists(target)) instructionFiles.push({ name, path: target, preview: (await readFile(target, "utf8")).slice(0, 1200) });
    }
    const skills = [];
    for (const directory of [path.join(cwd, ".agents", "skills"), path.join(cwd, ".claude", "skills")]) {
      if (!await exists(directory)) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && await exists(path.join(directory, entry.name, "SKILL.md"))) skills.push({ name: entry.name, path: path.join(directory, entry.name, "SKILL.md") });
      }
    }
    let pullRequest = null;
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number,title,url,state,headRefName,baseRefName,statusCheckRollup"], { cwd, env: githubEnvironment(cwd), encoding: "utf8", timeout: 6000, maxBuffer: 2 * 1024 * 1024 });
      pullRequest = JSON.parse(stdout);
    } catch { /* A worktree does not need an associated PR. */ }
    return { instructionFiles, skills, pullRequest };
  }

  async function requireWorktree(target) {
    const canonical = await canonicalPath(target);
    const known = getProjects().flatMap((project) => project.worktrees).some((worktree) => worktree.path === canonical || path.resolve(worktree.path) === canonical);
    if (!known) throw httpError(403, "Path is not a discovered worktree");
    return canonical;
  }

  async function requireScanRoot(target) {
    const config = await getConfig();
    const resolved = path.resolve(target);
    const inside = config.scanRoots.some((root) => isWithin(path.resolve(root), resolved));
    if (!inside) throw httpError(403, "Destination is outside configured scan roots");
    return resolved;
  }

  return { status, diff, stage, unstage, commit, createWorktree, removeWorktree, openInEditor, context, requireWorktree };
}

async function git(cwd, args, overrides = {}) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...overrides });
  return stdout.trimEnd();
}
async function safeGit(cwd, args, overrides = {}) { try { return await git(cwd, args, overrides); } catch { return ""; } }
async function gitOutputOnFailure(cwd, args) { try { return await git(cwd, args, { maxBuffer: 12 * 1024 * 1024 }); } catch (error) { return (error.stdout ?? "").trimEnd(); } }
// Porcelain v1 with -z: each record is "XY path"; renames/copies follow with
// the original path in a second record. No quoting or arrow separators.
function parsePorcelain(output) {
  const records = output.trimEnd().split("\0").filter(Boolean);
  let header = "";
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("## ")) { header = record; continue; }
    if (record.length < 4) continue;
    const entry = { index: record[0] ?? " ", worktree: record[1] ?? " ", path: record.slice(3) };
    if ("RC".includes(entry.index) || "RC".includes(entry.worktree)) entry.originalPath = records[++index] ?? null;
    entry.status = `${entry.index}${entry.worktree}`.trim() || "M";
    files.push(entry);
  }
  return { header, files };
}
async function validateFiles(cwd, files) { if (!Array.isArray(files) || !files.length) throw httpError(400, "At least one file is required"); for (const file of files) await requireChildPath(cwd, file); return files; }
async function requireChildPath(root, child) { const resolved = path.resolve(root, child); if (!isWithin(root, resolved)) throw httpError(403, "File path escapes the worktree"); return resolved; }
function isWithin(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
async function canonicalPath(target) { try { return await realpath(target); } catch { return path.resolve(target); } }
async function exists(target) { try { await access(target); return true; } catch { return false; } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

function githubEnvironment(cwd) {
  if (!cwd.includes(`${path.sep}dev${path.sep}n${path.sep}`)) return process.env;
  return { ...process.env, GH_CONFIG_DIR: "/Users/serro/.config/gh-other" };
}
