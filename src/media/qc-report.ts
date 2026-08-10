import path from 'node:path';
import {
  QcReportSchema,
  type QcReport,
} from '../contracts/schemas';
import {renderedTimelineDurationSeconds} from '../core/timeline';
import {readJson, writeJson} from '../core/json';
import {EditManifestSchema} from '../contracts/schemas';
import {readApprovalStatus} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {targetExpectations, type OutputTarget} from '../render/policy';
import {readRenderArtifactFreshness} from '../render/artifacts';
import {probeFile, runFfmpeg} from './ffmpeg';
import {
  parseBlackFrames,
  parseFreezeSections,
  inspectMp4FastStart,
  isSilentLoudness,
  parseLoudness,
  summarizeProbe,
  type DetectedSection,
} from './qc';
import {writeFile} from 'node:fs/promises';

type ApprovalStatus = {editApproved: boolean; colorApproved: boolean};
type Loudness = {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
};

export type QcEvaluationInput = {
  target: OutputTarget;
  now: Date;
  readable: boolean;
  renderFresh: boolean;
  silenceAllowed: boolean;
  observedSilent: boolean;
  approvals: ApprovalStatus;
  expectedDurationSeconds: number;
  observed: Record<string, unknown>;
  missingMedia: string[];
  blackFrames: DetectedSection[];
  freezeSections: DetectedSection[];
  blackDetectionSucceeded: boolean;
  freezeDetectionSucceeded: boolean;
  loudness: Loudness | null;
};

const valuesEqual = (key: string, expected: unknown, observed: unknown): boolean => {
  if (typeof expected === 'number' && typeof observed === 'number') {
    if (key === 'fps') {
      return Math.abs(expected - observed) <= 0.01;
    }
    if (key.endsWith('BitRate')) {
      return Math.abs(expected - observed) <= expected * 0.25;
    }
    return expected === observed;
  }
  return expected === observed;
};

export const evaluateQc = (input: QcEvaluationInput): QcReport => {
  const expected = {
    ...targetExpectations(input.target),
    durationSeconds: input.expectedDurationSeconds,
  };
  const checks: QcReport['checks'] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const add = (
    id: string,
    status: 'pass' | 'warn' | 'fail',
    message: string,
    expectedValue?: unknown,
    observedValue?: unknown,
  ) => {
    checks.push({id, status, message, expected: expectedValue, observed: observedValue});
    if (status === 'warn') warnings.push(message);
    if (status === 'fail') failures.push(message);
  };

  add(
    'readable',
    input.readable ? 'pass' : 'fail',
    input.readable ? 'Output is readable' : 'Output is missing or unreadable',
    true,
    input.readable,
  );
  add(
    'render-freshness',
    input.renderFresh ? 'pass' : 'fail',
    input.renderFresh
      ? 'Output is checksum-bound to the current manifests and render policy'
      : 'Output is missing a fresh artifact record for the current manifests',
    true,
    input.renderFresh,
  );
  const approvalsRequired = input.target !== 'preview';
  const approvalsCurrent = input.approvals.editApproved && input.approvals.colorApproved;
  add(
    'approvals',
    approvalsRequired && !approvalsCurrent ? 'fail' : 'pass',
    approvalsRequired && !approvalsCurrent
      ? 'Edit or color approval is missing or stale'
      : approvalsRequired
        ? 'Edit and color approvals match the current manifests'
        : 'Preview does not require final approvals',
    approvalsRequired ? {edit: true, color: true} : 'not-required',
    {edit: input.approvals.editApproved, color: input.approvals.colorApproved},
  );
  add(
    'missing-media',
    input.missingMedia.length ? 'fail' : 'pass',
    input.missingMedia.length
      ? `Missing or invalid media: ${input.missingMedia.join('; ')}`
      : 'All edit media is present and checksum-matched',
    [],
    input.missingMedia,
  );

  const expectedDuration = input.expectedDurationSeconds;
  const observedDuration = input.observed.durationSeconds;
  // AAC priming/padding can extend the MP4 container by roughly two frames even
  // when the video stream has the exact approved duration.
  const durationTolerance = input.target === 'preview' ? 0.08 : 1 / 30 + 0.02;
  const durationMatches =
    typeof observedDuration === 'number' &&
    Math.abs(observedDuration - expectedDuration) <= durationTolerance;
  add(
    'durationSeconds',
    durationMatches ? 'pass' : 'fail',
    durationMatches
      ? 'Duration matches the approved timeline'
      : `durationSeconds expected ${expectedDuration}, observed ${String(observedDuration)}`,
    expectedDuration,
    observedDuration,
  );

  for (const [key, expectedValue] of Object.entries(targetExpectations(input.target))) {
    if (key === 'integratedLufs' || key === 'truePeakDbtp') continue;
    const observedValue = input.observed[key];
    if (key === 'audioBitRate') {
      const observedPositive = typeof observedValue === 'number' && observedValue > 0;
      const matches = valuesEqual(key, expectedValue, observedValue);
      const status = !observedPositive
        ? 'fail'
        : matches || input.observedSilent
          ? 'pass'
          : 'warn';
      add(
        key,
        status,
        !observedPositive
          ? `${key} expected a positive value, observed ${String(observedValue)}`
          : matches
            ? `${key} is within tolerance`
            : input.observedSilent
              ? `${key} is content-compressed because the approved timeline is intentionally silent`
              : `${key} encoder setting is ${String(expectedValue)}; FFprobe reports a content-dependent average of ${String(observedValue)}`,
        expectedValue,
        observedValue,
      );
      continue;
    }
    const matches = valuesEqual(key, expectedValue, observedValue);
    add(
      key,
      matches ? 'pass' : 'fail',
      matches
        ? `${key} matches`
        : `${key} expected ${String(expectedValue)}, observed ${String(observedValue)}`,
      expectedValue,
      observedValue,
    );
  }

  if (!input.blackDetectionSucceeded) {
    add('black-frames', 'fail', 'Black-frame detector did not complete successfully', true, false);
  } else if (input.blackFrames.length) {
    add(
      'black-frames',
      'warn',
      `Detected ${input.blackFrames.length} black section(s); review whether they are intentional`,
      [],
      input.blackFrames,
    );
  } else {
    add('black-frames', 'pass', 'No black section longer than 0.5s detected', [], []);
  }
  if (!input.freezeDetectionSucceeded) {
    add('freeze-sections', 'fail', 'Freeze detector did not complete successfully', true, false);
  } else if (input.freezeSections.length) {
    add(
      'freeze-sections',
      'warn',
      `Detected ${input.freezeSections.length} frozen section(s) longer than 2s; review them`,
      [],
      input.freezeSections,
    );
  } else {
    add('freeze-sections', 'pass', 'No frozen section longer than 2s detected', [], []);
  }

  if (input.target === 'delivery') {
    if (!input.loudness && input.silenceAllowed && input.observedSilent) {
      add(
        'loudness',
        'pass',
        'Delivery is intentionally silent and retains the required AAC track',
        'intentional silence or −14 LUFS / −1.5 dBTP',
        'intentional silence',
      );
    } else if (!input.loudness) {
      add('loudness', 'fail', 'Delivery loudness could not be measured', {
        integratedLufs: -14,
        truePeakDbtp: -1.5,
      });
    } else {
      const integratedPass = Math.abs(input.loudness.integratedLufs - -14) <= 0.5;
      const truePeakPass = input.loudness.truePeakDbtp <= -1.4;
      add(
        'loudness',
        integratedPass && truePeakPass ? 'pass' : 'fail',
        integratedPass && truePeakPass
          ? 'Delivery loudness and true peak are within tolerance'
          : `loudness expected −14 LUFS / ≤−1.4 dBTP, observed ${input.loudness.integratedLufs} LUFS / ${input.loudness.truePeakDbtp} dBTP`,
        {integratedLufs: -14, truePeakDbtp: -1.5},
        input.loudness,
      );
    }
  }

  return QcReportSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: input.now.toISOString(),
    target: input.target,
    readable: input.readable,
    approvals: {
      edit: input.approvals.editApproved,
      color: input.approvals.colorApproved,
    },
    expected,
    observed: {
      ...input.observed,
      blackFrames: input.blackFrames,
      freezeSections: input.freezeSections,
      loudness: input.loudness,
    },
    checks,
    warnings,
    failures,
  });
};

const outputFor = (projectPath: string, target: OutputTarget): string => {
  if (target === 'preview') return path.join(projectPath, 'previews/preview.mp4');
  if (target === 'master') return path.join(projectPath, 'output/master.mov');
  return path.join(projectPath, 'output/delivery.mp4');
};

const reportMarkdown = (report: QcReport, outputPath: string): string => {
  const rows = report.checks
    .map((check) => `| ${check.status.toUpperCase()} | ${check.id} | ${check.message.replaceAll('|', '\\|')} |`)
    .join('\n');
  return `# ${report.target} QC report

- Generated: ${report.generatedAt}
- Output: ${outputPath}
- Result: ${report.failures.length ? 'FAIL' : report.warnings.length ? 'PASS WITH WARNINGS' : 'PASS'}

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Failures

${report.failures.length ? report.failures.map((failure) => `- ${failure}`).join('\n') : '- None'}

## Warnings

${report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : '- None'}
`;
};

export const runQc = async (
  projectPath: string,
  target: OutputTarget = 'delivery',
  now = new Date(),
): Promise<QcReport> => {
  const outputPath = outputFor(projectPath, target);
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  let approvals: ApprovalStatus = {editApproved: false, colorApproved: false};
  try {
    approvals = await readApprovalStatus(projectPath);
  } catch {
    // The report will expose invalid approvals rather than hiding other diagnostics.
  }
  let missingMedia: string[] = [];
  try {
    missingMedia = (await validateEdit(projectPath)).failures;
  } catch (error) {
    missingMedia = [(error as Error).message];
  }
  let readable = false;
  let observed: Record<string, unknown> = {};
  let blackFrames: DetectedSection[] = [];
  let freezeSections: DetectedSection[] = [];
  let blackDetectionSucceeded = false;
  let freezeDetectionSucceeded = false;
  let loudness: Loudness | null = null;
  let observedSilent = false;
  let renderFresh = false;
  try {
    renderFresh = (await readRenderArtifactFreshness(projectPath, target)).fresh;
  } catch {
    renderFresh = false;
  }
  try {
    observed = summarizeProbe(await probeFile(outputPath));
    if (target === 'preview' || target === 'delivery') {
      observed.fastStart = await inspectMp4FastStart(outputPath);
    }
    readable = true;
    const black = await runFfmpeg(
      ['-i', outputPath, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'],
      {allowFailure: true},
    );
    blackDetectionSucceeded = black.exitCode === 0;
    blackFrames = blackDetectionSucceeded ? parseBlackFrames(black.stderr) : [];
    const freeze = await runFfmpeg(
      ['-i', outputPath, '-vf', 'freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'],
      {allowFailure: true},
    );
    freezeDetectionSucceeded = freeze.exitCode === 0;
    freezeSections = freezeDetectionSucceeded ? parseFreezeSections(freeze.stderr) : [];
    if (observed.audioCodec) {
      const measured = await runFfmpeg(
        [
          '-i',
          outputPath,
          '-vn',
          '-af',
          'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
          '-f',
          'null',
          '-',
        ],
        {allowFailure: true},
      );
      loudness = parseLoudness(measured.stderr);
      observedSilent = isSilentLoudness(measured.stderr);
    }
  } catch {
    readable = false;
  }
  const report = evaluateQc({
    target,
    now,
    readable,
    renderFresh,
    silenceAllowed: !edit.music && edit.clips.every((clip) => clip.audio.muted),
    observedSilent,
    approvals,
    expectedDurationSeconds: renderedTimelineDurationSeconds(edit),
    observed,
    missingMedia,
    blackFrames,
    freezeSections,
    blackDetectionSucceeded,
    freezeDetectionSucceeded,
    loudness,
  });
  const jsonPath = path.join(projectPath, `analysis/qc-${target}.json`);
  const markdownPath = path.join(projectPath, `analysis/qc-${target}.md`);
  await writeJson(jsonPath, report);
  await writeFile(markdownPath, reportMarkdown(report, outputPath), 'utf8');
  return report;
};
