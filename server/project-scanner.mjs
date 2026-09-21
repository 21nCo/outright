import { execFile } from "node:child_process";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createObservability } from "@superfunctions/observability";

const execFileAsync = promisify(execFile);

const observability = createObservability({
  service: "outright",
  component: "project-scanner",
  metrics(metric) {
    if (process.env.OUTRIGHT_DEBUG === "1") {
      console.info("[outright:metric]", JSON.stringify(metric));
    }
  },
});

export async function loadOutrightConfig(configUrl) {
  const raw = await readFile(configUrl, "utf8");
  const parsed = JSON.parse(raw);
  const environmentRoots = process.env.OUTRIGHT_SCAN_ROOTS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    scanRoots: environmentRoots?.length ? environmentRoots : parsed.scanRoots,
    maxDepth: Number(process.env.OUTRIGHT_SCAN_DEPTH ?? parsed.maxDepth ?? 3),
    maxProjects: Number(parsed.maxProjects ?? 24),
    excludeDirectories: new Set(parsed.excludeDirectories ?? []),
  };
}

export async function scanProjects(config) {
  const request = observability.startRequest({ method: "SCAN", path: "/api/projects" });

  return observability.runWithRequest(request, async () => {
    const discoverSpan = request.span({ kind: "filesystem", operation: "discover-git-directories" });
    const candidates = await discoverGitDirectories(config);
    discoverSpan.end({ ok: true, labels: { candidates: String(candidates.length) } });

    const repositories = new Map();
    for (const candidate of candidates) {
      try {
        const commonDirectory = await git(candidate, ["rev-parse", "--git-common-dir"]);
        const commonPath = await canonicalPath(path.resolve(candidate, commonDirectory));
        if (!repositories.has(commonPath)) {
          repositories.set(commonPath, candidate);
        }
      } catch {
        // A stale or unsupported .git entry should not prevent the remaining projects from loading.
      }
    }

    const repositoryEntries = [...repositories.entries()].slice(0, config.maxProjects);
    const projects = (await mapWithConcurrency(repositoryEntries, 4, async ([commonPath, candidate]) => {
      try {
        return await readProject(candidate, commonPath);
      } catch (error) {
        if (process.env.OUTRIGHT_DEBUG === "1") {
          console.warn(`[outright] skipped ${candidate}:`, error.message);
        }
        return null;
      }
    })).filter(Boolean);

    projects.sort((a, b) => {
      const superfunctionsBias = Number(b.name === "superfunctions") - Number(a.name === "superfunctions");
      return superfunctionsBias || a.name.localeCompare(b.name);
    });

    const snapshot = request.finish({ status: 200 });
    return {
      projects,
      scannedAt: new Date().toISOString(),
      scanRoots: config.scanRoots,
      scanDurationMs: Math.round(snapshot.totalDurationMs * 100) / 100,
      candidateCount: candidates.length,
      repositoryCount: repositories.size,
      maxProjects: config.maxProjects,
      truncated: repositories.size > repositoryEntries.length,
    };
  });
}

async function discoverGitDirectories(config) {
  const discovered = [];
  const queue = config.scanRoots.map((root) => ({ directory: path.resolve(root), depth: 0 }));

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;

    if (await exists(path.join(current.directory, ".git"))) {
      discovered.push(current.directory);
      continue;
    }

    if (current.depth >= config.maxDepth) continue;

    let entries = [];
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (config.excludeDirectories.has(entry.name) || entry.name.startsWith(".")) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }

  return discovered;
}

async function readProject(candidate, commonPath) {
  const worktreeOutput = await git(candidate, ["worktree", "list", "--porcelain"]);
  const records = parseWorktreePorcelain(worktreeOutput);
  const worktrees = await Promise.all(records.map((record, index) => readWorktree(record, index > 0)));

  const primary = worktrees.find((worktree) => !worktree.isLinked) ?? worktrees[0];
  const projectPath = primary?.path ?? candidate;
  const projectName = path.basename(projectPath);

  for (const item of worktrees) {
    item.name = displayWorktreeName(item, projectName);
  }

  return {
    id: slug(`${commonPath}:${projectPath}`),
    name: projectName,
    path: projectPath,
    commonGitDirectory: commonPath,
    worktrees,
  };
}

async function readWorktree(record, isLinked) {
  const statusOutput = record.bare ? "" : await safeGit(record.path, ["status", "--porcelain=v1"]);
  const changedFiles = parseStatus(statusOutput);
  const divergence = record.bare ? null : await readDivergence(record.path);

  return {
    id: slug(record.path),
    path: record.path,
    name: path.basename(record.path),
    branch: record.branch?.replace("refs/heads/", "") ?? (record.detached ? "detached" : "unknown"),
    head: record.HEAD?.slice(0, 8) ?? "",
    isBare: Boolean(record.bare),
    isDetached: Boolean(record.detached),
    isPrunable: Boolean(record.prunable),
    isLinked,
    changedCount: changedFiles.length,
    changedFiles,
    ahead: divergence?.ahead ?? 0,
    behind: divergence?.behind ?? 0,
  };
}

async function readDivergence(directory) {
  const output = await safeGit(directory, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

export function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) records.push(current);
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: rest.join(" ") };
    } else if (current) {
      current[key] = rest.length ? rest.join(" ") : true;
    }
  }

  if (current) records.push(current);
  return records;
}

function parseStatus(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "M",
      path: line.slice(3).trim().replace(/^.* -> /, ""),
    }));
}

async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5000,
  });
  return stdout.trim();
}

async function safeGit(directory, args) {
  try {
    return await git(directory, args);
  } catch {
    return "";
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(target) {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function displayWorktreeName(worktree, projectName) {
  if (!worktree.isLinked) {
    return worktree.branch.split("/").at(-1) || projectName;
  }
  const directoryName = path.basename(worktree.path);
  return directoryName.startsWith(`${projectName}-`)
    ? directoryName.slice(projectName.length + 1)
    : directoryName;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
