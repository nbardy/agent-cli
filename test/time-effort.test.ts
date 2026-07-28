import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CODEX_REASONING_LEVELS,
  executeCommand,
  type ClaudeReasoningLevel,
  type CodexReasoningLevel,
  type ExecuteCommandCompletion,
  type ExecuteCommandRequest,
  type UnifiedAgentEvent,
} from '../src/run.ts';

// Live probe: runs real claude + codex harnesses across every reasoning
// effort level the shared CLI advertises. Gated by AGENT_CLI_TIME_EFFORT=1
// so it never runs in CI. Purpose is to confirm the effort pipe-through is
// wired end-to-end: harness argv -> CLI flag -> observable wall-time.

const enabled = process.env.AGENT_CLI_TIME_EFFORT === '1';
const samples = Number(process.env.AGENT_CLI_TIME_EFFORT_SAMPLES ?? 5);
const perRunTimeoutMs = Number(process.env.AGENT_CLI_TIME_EFFORT_TIMEOUT_MS ?? 90_000);
const claudeModel = process.env.AGENT_CLI_TIME_EFFORT_CLAUDE_MODEL ?? 'sonnet';
const codexModel = process.env.AGENT_CLI_TIME_EFFORT_CODEX_MODEL ?? 'gpt-5.4-mini';
const outDir =
  process.env.AGENT_CLI_TIME_EFFORT_OUT ??
  path.join(
    process.cwd(),
    'manual_tests',
    'runs',
    `time-effort-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );

// Ground truth. sqrt(79/131) = 0.776565151880... — the trailing decimals
// are fine to a reasonable precision for our distance metric.
const TRUE_SQRT = 0.77656515188;

const CLAUDE_LEVELS: readonly ClaudeReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEVELS: readonly CodexReasoningLevel[] = CODEX_REASONING_LEVELS;

const HIDE_TEST_PREFIX = '[_HIDE_TEST_]';
const PROMPT = [
  HIDE_TEST_PREFIX,
  'You can NOT use any tools, no programs, no calling calculators',
  '',
  'what is the sqrt of (79/131)?',
  '',
  'On the very last line of your reply, write exactly:',
  'ANSWER: <decimal number>',
].join('\n');

type HarnessName = 'claude' | 'codex';

interface SampleResult {
  sampleIndex: number;
  wallMs: number;
  reason: string;
  answer: number | null;
  distance: number | null;
  textSnippet: string;
}

interface EffortResult {
  harness: HarnessName;
  level: string;
  samples: SampleResult[];
  meanMs: number;
  medianMs: number;
  meanDistance: number | null;
  medianDistance: number | null;
  answeredCount: number;
}

function requireBinary(name: string): void {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    try {
      accessSync(`${dir}/${name}`, constants.X_OK);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length === 0 ? null : mean(defined);
}

function medianOrNull(values: readonly (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length === 0 ? null : median(defined);
}

// Prefer the explicit "ANSWER: X" line we asked for. Fall back to the last
// decimal number in the text so a cooperative-but-unformatted reply still
// contributes a data point instead of being scored as a null.
function extractAnswer(text: string): number | null {
  const labelled = /ANSWER\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (labelled) {
    const parsed = Number(labelled[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const allNumbers = text.match(/-?\d+\.\d+/g);
  if (allNumbers && allNumbers.length > 0) {
    const parsed = Number(allNumbers[allNumbers.length - 1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function collectEvents(
  events: AsyncIterable<UnifiedAgentEvent>
): Promise<UnifiedAgentEvent[]> {
  const out: UnifiedAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function runSample(
  harness: HarnessName,
  level: string,
  sampleIndex: number
): Promise<SampleResult> {
  const model = harness === 'claude' ? claudeModel : codexModel;
  const request: ExecuteCommandRequest =
    harness === 'claude'
      ? {
          harness: 'claude',
          mode: 'conversation',
          prompt: PROMPT,
          cwd: process.cwd(),
          model,
          reasoningEffort: level,
          yolo: true,
        }
      : {
          harness: 'codex',
          mode: 'conversation',
          prompt: PROMPT,
          cwd: process.cwd(),
          model,
          reasoningEffort: level,
          yolo: true,
        };

  const startedAt = Date.now();
  const turn = executeCommand(request);
  const eventsPromise = collectEvents(turn.events);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    turn.stop('SIGKILL');
  }, perRunTimeoutMs);

  let completion: ExecuteCommandCompletion;
  try {
    completion = await turn.completed;
  } catch (err) {
    clearTimeout(timer);
    const wallMs = Date.now() - startedAt;
    return {
      sampleIndex,
      wallMs,
      reason: `exception:${err instanceof Error ? err.message : String(err)}`,
      answer: null,
      distance: null,
      textSnippet: '',
    };
  } finally {
    clearTimeout(timer);
  }

  const wallMs = Date.now() - startedAt;
  const events = await eventsPromise;
  const text = events
    .filter((e): e is Extract<UnifiedAgentEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((e) => e.text)
    .join('');
  const answer = extractAnswer(text);
  const distance = answer === null ? null : Math.abs(answer - TRUE_SQRT);
  const snippet = text.slice(-240).replace(/\s+/g, ' ').trim();
  const reason = timedOut ? 'timeout' : completion.reason;

  return { sampleIndex, wallMs, reason, answer, distance, textSnippet: snippet };
}

async function runEffort(harness: HarnessName, level: string, n: number): Promise<EffortResult> {
  const samplesOut: SampleResult[] = [];
  for (let i = 0; i < n; i += 1) {
    const result = await runSample(harness, level, i);
    samplesOut.push(result);
    process.stderr.write(
      `[time-effort] ${harness}/${level} sample ${i + 1}/${n} ` +
        `wall=${(result.wallMs / 1000).toFixed(2)}s ` +
        `answer=${result.answer ?? 'n/a'} ` +
        `dist=${result.distance?.toFixed(5) ?? 'n/a'} ` +
        `reason=${result.reason}\n`
    );
  }

  const walls = samplesOut.map((s) => s.wallMs);
  const distances = samplesOut.map((s) => s.distance);
  return {
    harness,
    level,
    samples: samplesOut,
    meanMs: mean(walls),
    medianMs: median(walls),
    meanDistance: meanOrNull(distances),
    medianDistance: medianOrNull(distances),
    answeredCount: samplesOut.filter((s) => s.answer !== null).length,
  };
}

function asciiBar(value: number, maxValue: number, width = 32): string {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) return '';
  const filled = Math.max(1, Math.round((value / maxValue) * width));
  return '#'.repeat(filled);
}

function formatAsciiChart(
  title: string,
  rows: readonly { label: string; value: number | null; raw: string }[]
): string {
  const lines: string[] = [title, '-'.repeat(title.length)];
  const maxLabel = Math.max(...rows.map((r) => r.label.length));
  const definedValues = rows
    .map((r) => r.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const maxValue = definedValues.length > 0 ? Math.max(...definedValues) : 0;
  for (const row of rows) {
    const pad = row.label.padEnd(maxLabel, ' ');
    const bar = row.value === null ? '(no data)' : asciiBar(row.value, maxValue);
    lines.push(`  ${pad}  ${row.raw.padStart(10, ' ')}  ${bar}`);
  }
  return lines.join('\n');
}

function formatSvgChart(
  title: string,
  points: readonly { label: string; value: number | null }[],
  yAxisLabel: string
): string {
  const width = 640;
  const height = 320;
  const marginLeft = 70;
  const marginRight = 24;
  const marginTop = 32;
  const marginBottom = 48;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;
  const defined = points
    .map((p, i) => ({ ...p, i }))
    .filter(
      (p): p is { label: string; value: number; i: number } =>
        p.value !== null && Number.isFinite(p.value)
    );
  const maxValue = defined.length > 0 ? Math.max(...defined.map((p) => p.value)) : 1;
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;

  const axisColor = '#666';
  const lineColor = '#2a6fdb';
  const pointColor = '#c0392b';

  const pathData = defined
    .map((p, idx) => {
      const x = marginLeft + p.i * xStep;
      const y = marginTop + plotHeight - (p.value / maxValue) * plotHeight;
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const xLabels = points
    .map((p, i) => {
      const x = marginLeft + i * xStep;
      return `<text x="${x.toFixed(1)}" y="${(height - marginBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${axisColor}">${p.label}</text>`;
    })
    .join('');

  const yTicks = 4;
  const yTickLines: string[] = [];
  for (let i = 0; i <= yTicks; i += 1) {
    const v = (maxValue * i) / yTicks;
    const y = marginTop + plotHeight - (v / maxValue) * plotHeight;
    yTickLines.push(
      `<line x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${(width - marginRight).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eee" stroke-width="1" />`,
      `<text x="${(marginLeft - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${axisColor}">${v.toPrecision(3)}</text>`
    );
  }

  const pointCircles = defined
    .map((p) => {
      const x = marginLeft + p.i * xStep;
      const y = marginTop + plotHeight - (p.value / maxValue) * plotHeight;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${pointColor}" />`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="white" />
  <text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${title}</text>
  <text x="16" y="${(marginTop + plotHeight / 2).toFixed(1)}" transform="rotate(-90 16,${(marginTop + plotHeight / 2).toFixed(1)})" text-anchor="middle" font-size="11" fill="${axisColor}">${yAxisLabel}</text>
  ${yTickLines.join('\n  ')}
  <line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotHeight}" stroke="${axisColor}" stroke-width="1" />
  <line x1="${marginLeft}" y1="${marginTop + plotHeight}" x2="${width - marginRight}" y2="${marginTop + plotHeight}" stroke="${axisColor}" stroke-width="1" />
  <path d="${pathData}" fill="none" stroke="${lineColor}" stroke-width="2" />
  ${pointCircles}
  ${xLabels}
</svg>`;
}

function csvEscape(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(all: readonly EffortResult[]): string {
  const header = ['harness', 'level', 'sample', 'wall_ms', 'answer', 'distance', 'reason'].join(
    ','
  );
  const rows: string[] = [header];
  for (const effort of all) {
    for (const sample of effort.samples) {
      rows.push(
        [
          effort.harness,
          effort.level,
          sample.sampleIndex,
          sample.wallMs,
          sample.answer,
          sample.distance,
          sample.reason,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  }
  return rows.join('\n');
}

function buildReport(all: readonly EffortResult[]): string {
  const harnessNames: HarnessName[] = ['claude', 'codex'];
  const sections: string[] = [];
  sections.push(`# time-effort probe`);
  sections.push('');
  sections.push(`samples-per-effort: ${samples}`);
  sections.push(`per-run-timeout-ms: ${perRunTimeoutMs}`);
  sections.push(`ground-truth sqrt(79/131): ${TRUE_SQRT}`);
  sections.push('');

  for (const harness of harnessNames) {
    const rows = all.filter((r) => r.harness === harness);
    if (rows.length === 0) continue;

    sections.push(`## ${harness}`);
    sections.push('');

    const timeChart = formatAsciiChart(
      `${harness} — median wall time by effort`,
      rows.map((r) => ({
        label: r.level,
        value: r.medianMs,
        raw: `${(r.medianMs / 1000).toFixed(2)}s`,
      }))
    );
    const distanceChart = formatAsciiChart(
      `${harness} — median |answer - ${TRUE_SQRT}| by effort`,
      rows.map((r) => ({
        label: r.level,
        value: r.medianDistance,
        raw: r.medianDistance === null ? 'n/a' : r.medianDistance.toFixed(6),
      }))
    );
    sections.push('```');
    sections.push(timeChart);
    sections.push('');
    sections.push(distanceChart);
    sections.push('```');
    sections.push('');

    sections.push(`| level | answered | mean_ms | median_ms | mean_dist | median_dist |`);
    sections.push(`|---|---|---|---|---|---|`);
    for (const r of rows) {
      sections.push(
        `| ${r.level} | ${r.answeredCount}/${r.samples.length} | ${Math.round(r.meanMs)} | ${Math.round(r.medianMs)} | ${r.meanDistance?.toFixed(6) ?? 'n/a'} | ${r.medianDistance?.toFixed(6) ?? 'n/a'} |`
      );
    }
    sections.push('');
  }
  return sections.join('\n');
}

describe('time-effort probe', { skip: !enabled }, () => {
  it(
    'runs every claude + codex effort level through the shared CLI and records wall time + accuracy',
    { timeout: samples * perRunTimeoutMs * (CLAUDE_LEVELS.length + CODEX_LEVELS.length) + 60_000 },
    async () => {
      requireBinary('claude');
      requireBinary('codex');

      mkdirSync(outDir, { recursive: true });

      const allResults: EffortResult[] = [];
      for (const level of CLAUDE_LEVELS) {
        allResults.push(await runEffort('claude', level, samples));
      }
      for (const level of CODEX_LEVELS) {
        allResults.push(await runEffort('codex', level, samples));
      }

      const report = buildReport(allResults);
      writeFileSync(path.join(outDir, 'report.md'), report);
      writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(allResults, null, 2));
      writeFileSync(path.join(outDir, 'results.csv'), toCsv(allResults));

      for (const harness of ['claude', 'codex'] as const) {
        const rows = allResults.filter((r) => r.harness === harness);
        if (rows.length === 0) continue;
        writeFileSync(
          path.join(outDir, `${harness}-time.svg`),
          formatSvgChart(
            `${harness} — median wall time (ms) vs effort`,
            rows.map((r) => ({ label: r.level, value: r.medianMs })),
            'median wall time (ms)'
          )
        );
        writeFileSync(
          path.join(outDir, `${harness}-accuracy.svg`),
          formatSvgChart(
            `${harness} — median distance from sqrt(79/131) vs effort`,
            rows.map((r) => ({ label: r.level, value: r.medianDistance })),
            `|answer - ${TRUE_SQRT}|`
          )
        );
      }

      process.stderr.write(`\n${report}\n`);
      process.stderr.write(`[time-effort] wrote results to ${outDir}\n`);

      // Sanity check: the effort pipe-through is only useful if higher effort
      // actually costs more wall time. Compare median of the highest advertised
      // level against the lowest; noisy model timing means we don't assert a
      // strict monotonic chain, just endpoint ordering.
      for (const harness of ['claude', 'codex'] as const) {
        const rows = allResults.filter((r) => r.harness === harness);
        const first = rows[0];
        const last = rows[rows.length - 1];
        assert.ok(
          last.medianMs > first.medianMs,
          `${harness}: expected median time at "${last.level}" (${last.medianMs}ms) to exceed "${first.level}" (${first.medianMs}ms) — effort flag may not be plumbed through.`
        );
      }

      // At least one sample per harness should have produced a parseable
      // number; otherwise the prompt contract is broken and accuracy data
      // is meaningless.
      for (const harness of ['claude', 'codex'] as const) {
        const answered = allResults
          .filter((r) => r.harness === harness)
          .reduce((acc, r) => acc + r.answeredCount, 0);
        assert.ok(
          answered > 0,
          `${harness}: no sample produced a parseable numeric answer — check the ANSWER: format instruction.`
        );
      }
    }
  );
});
