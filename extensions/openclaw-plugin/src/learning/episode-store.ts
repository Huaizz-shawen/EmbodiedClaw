import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "../plugin-api.js";

type EpisodeStatus = "success" | "error";

export interface EpisodeRecord {
  ts: string;
  tool: string;
  status: EpisodeStatus;
  durationMs: number;
  transportMode: string | null;
  params: unknown;
  result?: unknown;
  error?: string;
}

interface DistillFailureEntry {
  key: string;
  tool: string;
  error: string;
  count: number;
  lastSeen: string;
  sampleParams: unknown;
}

interface DistillReport {
  generatedAt: string;
  totalEpisodes: number;
  successCount: number;
  errorCount: number;
  failureLibrary: DistillFailureEntry[];
}

let learningRoot: string | null = null;
let learningLogger: PluginLogger | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function dateStamp(iso: string): string {
  return iso.slice(0, 10);
}

function safeJson(value: unknown, maxLen = 2400): unknown {
  try {
    const s = JSON.stringify(value);
    if (!s) return value;
    if (s.length <= maxLen) return value;
    return { _truncated: true, preview: `${s.slice(0, maxLen)}...` };
  } catch {
    return String(value);
  }
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function learningPath(...parts: string[]): string {
  if (!learningRoot) {
    throw new Error("Learning store not initialized");
  }
  return join(learningRoot, ...parts);
}

async function ensureDirs(): Promise<void> {
  await mkdir(learningPath("episodes"), { recursive: true });
  await mkdir(learningPath("failures"), { recursive: true });
  await mkdir(learningPath("reports"), { recursive: true });
}

export async function initLearningStore(stateDir: string, logger: PluginLogger): Promise<void> {
  learningRoot = join(stateDir, "rosclaw-learning");
  learningLogger = logger;
  await ensureDirs();
  logger.info(`RosClaw learning store ready: ${learningRoot}`);
}

export async function recordEpisode(input: EpisodeRecord): Promise<void> {
  if (!learningRoot) return;
  const ts = input.ts || nowIso();
  const record: EpisodeRecord = {
    ...input,
    ts,
    params: safeJson(input.params),
    result: input.result === undefined ? undefined : safeJson(input.result),
    error: input.error ? sanitizeError(input.error) : undefined,
  };
  const line = `${JSON.stringify(record)}\n`;
  const file = learningPath("episodes", `${dateStamp(ts)}.jsonl`);
  try {
    await appendFile(file, line, "utf-8");
  } catch (err) {
    learningLogger?.warn(`Failed to append episode trace: ${String(err)}`);
  }
}

async function loadAllEpisodes(): Promise<EpisodeRecord[]> {
  if (!learningRoot) return [];
  let files: string[] = [];
  try {
    files = await readdir(learningPath("episodes"));
  } catch {
    return [];
  }

  const rows: EpisodeRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const full = learningPath("episodes", file);
    let content = "";
    try {
      content = await readFile(full, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as EpisodeRecord);
      } catch {
        // skip malformed line
      }
    }
  }

  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  return rows;
}

function buildFailureLibrary(episodes: EpisodeRecord[]): DistillFailureEntry[] {
  const grouped = new Map<string, DistillFailureEntry>();
  for (const ep of episodes) {
    if (ep.status !== "error") continue;
    const err = (ep.error || "unknown_error").slice(0, 300);
    const key = `${ep.tool}::${err}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        tool: ep.tool,
        error: err,
        count: 1,
        lastSeen: ep.ts,
        sampleParams: ep.params,
      });
      continue;
    }
    existing.count += 1;
    if (ep.ts > existing.lastSeen) {
      existing.lastSeen = ep.ts;
      existing.sampleParams = ep.params;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.count - a.count);
}

function reportName(ts: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

export async function distillEpisodes(): Promise<{
  reportPath: string;
  failureLibraryPath: string;
  summary: DistillReport;
}> {
  if (!learningRoot) {
    throw new Error("Learning store not initialized");
  }
  await ensureDirs();
  const episodes = await loadAllEpisodes();
  const failureLibrary = buildFailureLibrary(episodes);
  const successCount = episodes.filter((e) => e.status === "success").length;
  const errorCount = episodes.length - successCount;
  const summary: DistillReport = {
    generatedAt: nowIso(),
    totalEpisodes: episodes.length,
    successCount,
    errorCount,
    failureLibrary,
  };

  const failureLibraryPath = learningPath("failures", "failure-library.json");
  await writeFile(failureLibraryPath, JSON.stringify(summary, null, 2), "utf-8");

  const stamp = reportName(new Date());
  const reportPath = learningPath("reports", `distill-${stamp}.md`);
  const lines: string[] = [];
  lines.push("# RosClaw Distillation Report");
  lines.push("");
  lines.push(`GeneratedAt: ${summary.generatedAt}`);
  lines.push(`TotalEpisodes: ${summary.totalEpisodes}`);
  lines.push(`Success: ${summary.successCount}`);
  lines.push(`Errors: ${summary.errorCount}`);
  lines.push("");
  lines.push("## Top Failures");
  lines.push("");
  if (failureLibrary.length === 0) {
    lines.push("- No failures recorded.");
  } else {
    for (const row of failureLibrary.slice(0, 20)) {
      lines.push(`- ${row.tool}: ${row.error} (count=${row.count}, lastSeen=${row.lastSeen})`);
    }
  }
  lines.push("");
  await writeFile(reportPath, `${lines.join("\n")}\n`, "utf-8");

  return { reportPath, failureLibraryPath, summary };
}

export async function getLearningStoreStats(): Promise<{
  root: string | null;
  episodesBytes: number;
}> {
  if (!learningRoot) return { root: null, episodesBytes: 0 };
  let total = 0;
  try {
    const files = await readdir(learningPath("episodes"));
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const st = await stat(learningPath("episodes", file));
        total += st.size;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { root: learningRoot, episodesBytes: total };
}
