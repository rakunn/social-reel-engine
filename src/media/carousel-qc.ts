import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  QcReportSchema,
  type QcReport,
} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {readApprovalStatus} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {
  expectedCarouselFingerprint,
  readCarouselPackageFreshness,
  readCarouselPackageRecord,
  type CarouselPackageFreshness,
  type CarouselPackageRecord,
} from '../render/carousel';
import {
  invalidateCarouselSharePackage,
  syncCarouselSharePackage,
} from '../render/carousel-share';
import {findRenderInterruption} from '../render/errors';
import {
  deliveryLoudnormAnalysisFilter,
  readRenderSettings,
} from '../render/policy';
import {evaluateQc} from './qc-report';
import {writeAtomically} from './atomic-output';
import {probeFile, runFfmpeg} from './ffmpeg';
import {
  inspectMp4FastStart,
  isSilentLoudness,
  parseBlackFrames,
  parseFreezeSections,
  parseLoudness,
  summarizeProbe,
  type DetectedSection,
} from './qc';
import {
  assertVerifiedInputSnapshotUnchanged,
  createSourceIntegrityContext,
  type SourceIntegrityContext,
} from './source-integrity';

export const CarouselQcReportSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: z.string().datetime({offset: true}),
    packageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    cards: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        clipId: z.string().min(1),
        file: z.string().min(1),
        report: QcReportSchema,
      }),
    ),
    warnings: z.array(z.string()),
    failures: z.array(z.string()),
  })
  .strict();

export type CarouselQcReport = z.infer<typeof CarouselQcReportSchema>;

export const carouselQcMatchesPackage = (
  packageRecord: CarouselPackageRecord,
  report: CarouselQcReport,
): boolean => {
  if (
    report.packageFingerprint !== packageRecord.fingerprint ||
    report.cards.length !== packageRecord.cards.length
  ) {
    return false;
  }
  return packageRecord.cards.every((card, index) => {
    const qcCard = report.cards[index];
    const artifact = qcCard?.report.renderArtifact;
    return (
      qcCard?.index === card.index &&
      qcCard.clipId === card.clipId &&
      qcCard.file === card.file &&
      artifact?.fingerprint === packageRecord.fingerprint &&
      artifact.checksumSha256 === card.checksumSha256 &&
      artifact.sizeBytes === card.sizeBytes
    );
  });
};

export const summarizeCarouselQc = (
  packageRecord: CarouselPackageRecord,
  reports: QcReport[],
  now = new Date(),
): CarouselQcReport => {
  if (reports.length !== packageRecord.cards.length) {
    throw new Error(
      `Carousel QC report count ${reports.length} does not match ${packageRecord.cards.length} cards`,
    );
  }
  const cards = packageRecord.cards.map((card, index) => ({
    index: card.index,
    clipId: card.clipId,
    file: card.file,
    report: reports[index],
  }));
  return CarouselQcReportSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    packageFingerprint: packageRecord.fingerprint,
    cards,
    warnings: cards.flatMap((card) =>
      card.report.warnings.map((warning) => `${card.clipId}: ${warning}`),
    ),
    failures: cards.flatMap((card) =>
      card.report.failures.map((failure) => `${card.clipId}: ${failure}`),
    ),
  });
};

export type RunCarouselQcOptions = {
  integrity?: SourceIntegrityContext;
  probeFile?: typeof probeFile;
  runFfmpeg?: typeof runFfmpeg;
  inspectFastStart?: typeof inspectMp4FastStart;
};

const carouselQcMarkdown = (
  report: CarouselQcReport,
  projectPath: string,
): string => {
  const sections = report.cards.map((card) => {
    const checks = card.report.checks
      .map(
        (check) =>
          `| ${check.status.toUpperCase()} | ${check.id} | ${check.message.replaceAll('|', '\\|')} |`,
      )
      .join('\n');
    return `## ${String(card.index + 1).padStart(2, '0')} — ${card.clipId}

- Output: ${resolveInside(projectPath, card.file)}
- Result: ${card.report.failures.length ? 'FAIL' : card.report.warnings.length ? 'PASS WITH WARNINGS' : 'PASS'}

| Status | Check | Detail |
| --- | --- | --- |
${checks}
`;
  });
  return `# Carousel QC report

- Generated: ${report.generatedAt}
- Package fingerprint: ${report.packageFingerprint}
- Cards: ${report.cards.length}
- Result: ${report.failures.length ? 'FAIL' : report.warnings.length ? 'PASS WITH WARNINGS' : 'PASS'}

${sections.join('\n')}
## Failures

${report.failures.length ? report.failures.map((failure) => `- ${failure}`).join('\n') : '- None'}

## Warnings

${report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : '- None'}
`;
};

export const runCarouselQc = async (
  projectPath: string,
  now = new Date(),
  options: RunCarouselQcOptions = {},
): Promise<CarouselQcReport> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const probeMedia = options.probeFile ?? probeFile;
  const runMediaFfmpeg = options.runFfmpeg ?? runFfmpeg;
  const inspectFastStart = options.inspectFastStart ?? inspectMp4FastStart;
  await invalidateCarouselSharePackage(projectPath);
  const packageRecord = await readCarouselPackageRecord(projectPath);
  if (!packageRecord) throw new Error('Carousel package is missing; run render-carousel first');
  let packageFreshness: CarouselPackageFreshness = {
    fresh: false,
    reason: 'Carousel fingerprint could not be evaluated',
  };
  let fingerprintFailure: string | null = null;
  try {
    const expectedFingerprint = await expectedCarouselFingerprint(projectPath, {integrity});
    packageFreshness = await readCarouselPackageFreshness(projectPath, {
      expectedFingerprint,
    });
  } catch (error) {
    fingerprintFailure = (error as Error).message;
  }
  const [settings, edit] = await Promise.all([
    readRenderSettings(projectPath),
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
  ]);
  let approvals = {editApproved: false, colorApproved: false};
  try {
    approvals = await readApprovalStatus(projectPath, {integrity});
  } catch {
    // Per-card reports expose stale approvals with the rest of the diagnostics.
  }
  let missingMedia: string[] = [];
  try {
    missingMedia = (await validateEdit(projectPath, edit, {integrity})).failures;
  } catch (error) {
    missingMedia = [(error as Error).message];
  }
  if (fingerprintFailure) missingMedia.push(fingerprintFailure);

  const reports: QcReport[] = [];
  for (const card of packageRecord.cards) {
    const outputPath = resolveInside(projectPath, card.file);
    let readable = false;
    let observed: Record<string, unknown> = {};
    let blackFrames: DetectedSection[] = [];
    let freezeSections: DetectedSection[] = [];
    let blackDetectionSucceeded = false;
    let freezeDetectionSucceeded = false;
    let loudness: ReturnType<typeof parseLoudness> = null;
    let observedSilent = false;
    try {
      observed = summarizeProbe(await probeMedia(outputPath));
      observed.fastStart = await inspectFastStart(outputPath);
      readable = true;
      const black = await runMediaFfmpeg(
        ['-i', outputPath, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'],
        {allowFailure: true},
      );
      blackDetectionSucceeded = black.exitCode === 0;
      blackFrames = blackDetectionSucceeded ? parseBlackFrames(black.stderr) : [];
      const freeze = await runMediaFfmpeg(
        ['-i', outputPath, '-vf', 'freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'],
        {allowFailure: true},
      );
      freezeDetectionSucceeded = freeze.exitCode === 0;
      freezeSections = freezeDetectionSucceeded ? parseFreezeSections(freeze.stderr) : [];
      if (observed.audioCodec) {
        const measured = await runMediaFfmpeg(
          [
            '-i',
            outputPath,
            '-vn',
            '-af',
            deliveryLoudnormAnalysisFilter(settings),
            '-f',
            'null',
            '-',
          ],
          {allowFailure: true},
        );
        loudness = parseLoudness(measured.stderr);
        observedSilent = isSilentLoudness(measured.stderr);
      }
    } catch (error) {
      if (findRenderInterruption(error)) throw error;
      readable = false;
    }
    const editClip = edit.clips[card.index];
    const cardIdentityMatches = editClip?.id === card.clipId;
    reports.push(
      evaluateQc({
        target: 'delivery',
        now,
        readable,
        renderFresh: packageFreshness.fresh && cardIdentityMatches,
        renderArtifact: {
          fingerprint: packageRecord.fingerprint,
          checksumSha256: card.checksumSha256,
          sizeBytes: card.sizeBytes,
        },
        silenceAllowed: editClip?.audio.muted ?? false,
        observedSilent,
        approvals,
        expectedDurationSeconds: card.durationSeconds,
        observed,
        missingMedia: cardIdentityMatches
          ? missingMedia
          : [...missingMedia, `${card.clipId}: package order does not match the edit`],
        blackFrames,
        freezeSections,
        blackDetectionSucceeded,
        freezeDetectionSucceeded,
        loudness,
        renderSettings: settings,
      }),
    );
  }
  const report = summarizeCarouselQc(packageRecord, reports, now);
  await assertVerifiedInputSnapshotUnchanged(projectPath, integrity);
  await writeJson(path.join(projectPath, 'analysis/qc-carousel.json'), report);
  const markdownPath = path.join(projectPath, 'analysis/qc-carousel.md');
  await writeAtomically(markdownPath, async (temporaryPath) => {
    await writeFile(temporaryPath, carouselQcMarkdown(report, projectPath), 'utf8');
  });
  await syncCarouselSharePackage(projectPath, packageRecord, report.failures, now);
  return report;
};
