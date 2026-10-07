import { access, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createObservability } from "@superfunctions/observability";
import { utilityBudgetUnavailable, utilityProcesses } from "./subprocess-budget.mjs";

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

export async function scanProjects(config, subprocesses = utilityProcesses) {
  const git = (directory, args) => runGit(subprocesses, directory, args);
  const safeGit = async (directory, args) => {
    try { return await git(directory, args); }
    catch (error) {
      if (utilityBudgetUnavailable(error)) throw error;
      return "";
    }
  };
  const request = observability.startRequest({ method: "SCAN", path: "/api/projects" });

  return observability.runWithRequest(request, async () => {
    const discoverSpan = request.span({ kind: "filesystem", operation: "discover-git-directories" });
    const candidates = await discoverGitDirectories(config);
    discoverSpan.end({ ok: true, labels: { candidates: String(candidates.length) } });

    // Native Git ownership setup has a measurable per-call cost. Resolve a
    // bounded pair at a time, then deduplicate in discovery order so the
    // first path still wins when multiple worktrees share one repository.
    const resolvedCandidates = await mapWithConcurrency(candidates, 2, async (candidate) => {
      try {
        const commonDirectory = await git(candidate, ["rev-parse", "--git-common-dir"]);
        const commonPath = await canonicalPath(path.resolve(candidate, commonDirectory));
        return { commonPath, candidate };
      } catch (error) {
        if (utilityBudgetUnavailable(error)) throw error;
        // A stale or unsupported .git entry should not prevent the remaining projects from loading.
        return null;
      }
    });
    const repositories = new Map();
    for (const resolved of resolvedCandidates) {
      if (resolved && !repositories.has(resolved.commonPath)) repositories.set(resolved.commonPath, resolved.candidate);
    }

    const repositoryEntries = [...repositories.entries()].slice(0, config.maxProjects);
    const projects = (await mapWithConcurrency(repositoryEntries, 2, async ([commonPath, candidate]) => {
      try {
        return await readProject(candidate, commonPath, git, safeGit);
      } catch (error) {
        if (utilityBudgetUnavailable(error)) throw error;
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

async function readProject(candidate, commonPath, git, safeGit) {
  const worktreeOutput = await git(candidate, ["worktree", "list", "--porcelain"]);
  const records = parseWorktreePorcelain(worktreeOutput);
  const worktrees = await mapWithConcurrency(records, 2, (record, index) => readWorktree(record, index > 0, safeGit));

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

async function readWorktree(record, isLinked, safeGit) {
  // Porcelain's branch header carries the same upstream counts as rev-list.
  // One owned Git invocation per worktree keeps large default-root scans
  // responsive without weakening native process ownership.
  const statusOutput = record.bare ? "" : await safeGit(record.path, ["status", "--porcelain=v1", "--branch"]);
  const { changedFiles, divergence } = parseStatus(statusOutput);

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

export function parseStatus(output) {
  const lines = output.split("\n").filter(Boolean);
  const branch = lines[0]?.startsWith("## ") ? lines.shift() : "";
  const counts = /\[([^\]]+)\]/.exec(branch)?.[1] ?? "";
  const ahead = Number(/\bahead (\d+)\b/.exec(counts)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)\b/.exec(counts)?.[1] ?? 0);
  return { divergence: { ahead, behind }, changedFiles: lines.map((line) => ({
      status: line.slice(0, 2).trim() || "M",
      path: line.slice(3).trim().replace(/^.* -> /, ""),
    })) };
}

async function runGit(subprocesses, directory, args) {
  const { stdout } = await subprocesses.run("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5000,
  });
  return stdout.trim();
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

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure;
  async function worker() {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
  return results;
}
