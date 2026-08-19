import {access, cp, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  ReelBriefSchema,
  RenderSettingsSchema,
} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {assertSafeReelName} from '../core/paths';
import {validateEdit} from '../edit/validate';
import {scanInputs} from './ingest';
import {
  isMediaOperationLockActive,
  isMediaOperationAlive,
  readMediaOperation,
  runWithStatusScanLock,
  type MediaOperationRecord,
} from './operation';

export type ProjectFormat = 'reel-9:16' | 'carousel-1.91:1';

type CreateReelProjectOptions = {
  engineRoot: string;
  projectsRoot?: string;
  reelName: string;
  title?: string;
  format?: ProjectFormat;
  now?: Date;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const assertProjectScaffold = async (projectPath: string): Promise<void> => {
  const required = [
    projectPath,
    path.join(projectPath, 'brief.json'),
    path.join(projectPath, 'analysis'),
    path.join(projectPath, 'config'),
    path.join(projectPath, 'edits/edit.json'),
  ];
  try {
    await Promise.all(required.map(async (requiredPath) => await access(requiredPath)));
  } catch {
    throw new Error(
      `Reel project "${path.basename(projectPath)}" does not exist or is incomplete. Run reel new ${path.basename(projectPath)} first.`,
    );
  }
};

export const createReelProject = async ({
  engineRoot,
  projectsRoot = path.join(engineRoot, 'projects'),
  reelName,
  title,
  format = 'reel-9:16',
  now = new Date(),
}: CreateReelProjectOptions): Promise<string> => {
  const safeName = assertSafeReelName(reelName);
  const projectPath = path.resolve(projectsRoot, safeName);
  const resolvedProjectsRoot = path.resolve(projectsRoot);
  if (!projectPath.startsWith(`${resolvedProjectsRoot}${path.sep}`)) {
    throw new Error('Project path escaped the configured projects root');
  }
  if (await exists(projectPath)) {
    throw new Error(`Reel project "${safeName}" already exists`);
  }
  const profile =
    format === 'carousel-1.91:1'
      ? {
          projectType: 'carousel' as const,
          target: {minSeconds: 4, idealSeconds: 4.5, maxSeconds: 5},
          output: {width: 1910 as const, height: 1000 as const, fps: 30 as const},
          preview: {width: 764 as const, height: 400 as const},
          options: {music: false, captions: false, cameraAudio: false},
        }
      : {
          projectType: 'reel' as const,
          target: {minSeconds: 20, idealSeconds: 25, maxSeconds: 30},
          output: {width: 1080 as const, height: 1920 as const, fps: 30 as const},
          preview: {width: 540 as const, height: 960 as const},
          options: null,
        };
  const templateBriefPath = path.join(engineRoot, 'templates/reel/brief.json');
  const templateBrief = await readJson<Record<string, unknown>>(templateBriefPath);
  const templateOptions = templateBrief.options as Record<string, unknown> | undefined;
  const brief = ReelBriefSchema.parse({
    ...templateBrief,
    projectType: profile.projectType,
    target: profile.target,
    output: profile.output,
    options: profile.options ?? templateOptions,
    identity: {
      reelName: safeName,
      title: title?.trim() || safeName.replaceAll('-', ' '),
      createdAt: now.toISOString(),
    },
  });
  await mkdir(resolvedProjectsRoot, {recursive: true});
  await cp(path.join(engineRoot, 'templates/reel'), projectPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const briefPath = path.join(projectPath, 'brief.json');
  await writeJson(briefPath, brief);

  const editPath = path.join(projectPath, 'edits/edit.json');
  const edit = JSON.parse(await readFile(editPath, 'utf8')) as Record<string, unknown>;
  await writeJson(editPath, {...edit, reelName: safeName, output: profile.output});

  const settingsPath = path.join(projectPath, 'config/settings.json');
  const settings = await readJson<Record<string, unknown>>(settingsPath);
  const previewSettings = settings.preview as Record<string, unknown>;
  const masterSettings = settings.master as Record<string, unknown>;
  const nextSettings = RenderSettingsSchema.parse({
    ...settings,
    preview: {...previewSettings, ...profile.preview},
    master: {...masterSettings, ...profile.output},
  });
  await writeJson(settingsPath, nextSettings);
  return projectPath;
};

export type ProjectStatus = {
  stage:
    | 'awaiting-inputs'
    | 'awaiting-analysis'
    | 'awaiting-edit'
    | 'awaiting-preview'
    | 'awaiting-edit-approval'
    | 'awaiting-color-approval'
    | 'awaiting-rights-confirmation'
    | 'ready-to-render'
    | 'rendered'
    | 'ready-to-render-carousel'
    | 'awaiting-carousel-qc'
    | 'carousel-rendered'
    | 'ready-to-create-photos'
    | 'awaiting-photo-approval'
    | 'photos-rendered'
    | 'media-in-progress'
    | 'interrupted-media-job';
  nextAction: string;
  inputs: number;
  editApproved: boolean;
  colorApproved: boolean;
  activity?: Pick<
    MediaOperationRecord,
    'command' | 'phase' | 'progress' | 'startedAt' | 'updatedAt' | 'finishedAt' | 'error'
  >;
};

const statusActivity = (record: MediaOperationRecord) => ({
  command: record.command,
  phase: record.phase,
  progress: record.progress,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  finishedAt: record.finishedAt,
  error: record.error,
});

const statusFromOperation = (operation: MediaOperationRecord): ProjectStatus => {
  const base = {inputs: 0, editApproved: false, colorApproved: false, activity: statusActivity(operation)};
  if (isMediaOperationAlive(operation)) {
    return {
      ...base,
      stage: 'media-in-progress',
      nextAction: `${operation.command} is running (${operation.phase}). Wait for completion before starting another media command.`,
    };
  }
  if (operation.state === 'failed' && operation.error) {
    return {
      ...base,
      stage: 'interrupted-media-job',
      nextAction: `${operation.command} failed during ${operation.phase}: ${operation.error}. Resolve the failure, then run ${operation.command} again.`,
    };
  }
  return {
    ...base,
    stage: 'interrupted-media-job',
    nextAction: `Run ${operation.command} again to replace interrupted work safely.`,
  };
};

const mediaOperationStartingStatus = (): ProjectStatus => ({
  inputs: 0,
  editApproved: false,
  colorApproved: false,
  stage: 'media-in-progress',
  nextAction: 'A media operation is starting. Wait for it to publish activity before requesting status again.',
});

const statusScanInProgressStatus = (): ProjectStatus => ({
  inputs: 0,
  editApproved: false,
  colorApproved: false,
  stage: 'media-in-progress',
  nextAction: 'Project status is checking inputs. Wait for it to finish, then request status again.',
});

const getProjectStatusWithoutOperation = async (projectPath: string): Promise<ProjectStatus> => {
  const inputs = (await scanInputs(projectPath)).files.filter(
    (file) => file.kind === 'clips',
  ).length;
  const base = {inputs, editApproved: false, colorApproved: false};
  if (inputs === 0) {
    return {
      ...base,
      stage: 'awaiting-inputs',
      nextAction: 'Add original MP4/MOV files to input/clips or run ingest.',
    };
  }
  if (!(await exists(path.join(projectPath, 'analysis/sources.json')))) {
    return {...base, stage: 'awaiting-analysis', nextAction: 'Run analyze, proxy, and beats.'};
  }
  try {
    const {readValidatedSourceManifest} = await import('../media/source-integrity');
    await readValidatedSourceManifest(projectPath);
  } catch {
    return {...base, stage: 'awaiting-analysis', nextAction: 'Run analyze, proxy, and beats.'};
  }
  let edit;
  let brief;
  try {
    edit = EditManifestSchema.parse(await readJson(path.join(projectPath, 'edits/edit.json')));
    brief = ReelBriefSchema.parse(await readJson(path.join(projectPath, 'brief.json')));
  } catch {
    return {...base, stage: 'awaiting-edit', nextAction: 'Create and validate edits/edit.json.'};
  }
  try {
    const validation = await validateEdit(projectPath, edit);
    if (!validation.valid) {
      return {
        ...base,
        stage: 'awaiting-edit',
        nextAction: 'Fix and validate edits/edit.json before rendering a rough cut.',
      };
    }
  } catch {
    return {
      ...base,
      stage: 'awaiting-edit',
      nextAction: 'Fix and validate edits/edit.json before rendering a rough cut.',
    };
  }
  const {readRenderArtifactFreshness} = await import('../render/artifacts');
  try {
    const preview = await readRenderArtifactFreshness(projectPath, 'preview');
    if (!preview.fresh) {
      return {
        ...base,
        stage: 'awaiting-preview',
        nextAction: 'Run preview to render the current rough cut, then review it.',
      };
    }
  } catch {
    return {
      ...base,
      stage: 'awaiting-preview',
      nextAction: 'Run preview to render the current rough cut, then review it.',
    };
  }
  ApprovalStateSchema.parse(await readJson(path.join(projectPath, 'analysis/approvals.json')));
  const {readApprovalReadiness} = await import('../edit/approve');
  const {editApproved, colorApproved, colorReviewReady} =
    await readApprovalReadiness(projectPath);
  if (!editApproved) {
    return {...base, stage: 'awaiting-edit-approval', nextAction: 'Review the rough cut, then run approve-edit.'};
  }
  if (!colorApproved) {
    return {
      ...base,
      editApproved,
      stage: 'awaiting-color-approval',
      nextAction: colorReviewReady
        ? 'Review graded reference frames, then run approve-color.'
        : 'Run grade-stills, review the graded reference frames, then run approve-color.',
    };
  }
  const {readRightsConfirmationStatus} = await import('../edit/rights');
  const rights = await readRightsConfirmationStatus(projectPath);
  if (!rights.confirmed) {
    return {
      ...base,
      editApproved,
      colorApproved,
      stage: 'awaiting-rights-confirmation',
      nextAction: `${rights.reason}. After explicit user confirmation, run confirm-rights.`,
    };
  }
  if (brief.projectType === 'carousel') {
    const {
      evaluateCarouselOutputStatus,
      readCarouselPackageFreshness,
      readCarouselPackageRecord,
    } = await import('../render/carousel');
    const {CarouselQcReportSchema} = await import('../media/carousel-qc');
    const [packageRecord, freshness] = await Promise.all([
      readCarouselPackageRecord(projectPath),
      readCarouselPackageFreshness(projectPath).catch(() => ({
        fresh: false,
        reason: 'Carousel package is missing or stale',
      })),
    ]);
    let qcPackageFingerprint: string | null = null;
    let qcFailures: string[] = [];
    try {
      const qc = await readJson(
        path.join(projectPath, 'analysis/qc-carousel.json'),
        CarouselQcReportSchema,
      );
      qcPackageFingerprint = qc.packageFingerprint;
      qcFailures = qc.failures;
    } catch {
      qcPackageFingerprint = null;
    }
    const carouselStatus = evaluateCarouselOutputStatus(
      freshness.fresh,
      packageRecord?.fingerprint ?? null,
      qcPackageFingerprint,
      qcFailures,
    );
    if (carouselStatus === 'ready') {
      return {
        ...base,
        editApproved,
        colorApproved,
        stage: 'ready-to-render-carousel',
        nextAction: 'Run grade, render-carousel, and qc-carousel.',
      };
    }
    if (carouselStatus === 'awaiting-qc') {
      return {
        ...base,
        editApproved,
        colorApproved,
        stage: 'awaiting-carousel-qc',
        nextAction: qcFailures.length
          ? 'Review carousel QC failures, correct the output, then rerun render-carousel and qc-carousel.'
          : 'Run qc-carousel and review the consolidated report.',
      };
    }
    return {
      ...base,
      editApproved,
      colorApproved,
      stage: 'carousel-rendered',
      nextAction: 'Review the ordered carousel MP4 package and consolidated QC report.',
    };
  }
  const [master, delivery] = await Promise.all([
    readRenderArtifactFreshness(projectPath, 'master'),
    readRenderArtifactFreshness(projectPath, 'delivery'),
  ]);
  if (master.fresh && delivery.fresh) {
    const {readPhotoOutputStatus} = await import('../media/photos');
    const photos = await readPhotoOutputStatus(projectPath);
    if (photos === 'awaiting-approval') {
      return {
        ...base,
        editApproved,
        colorApproved,
        stage: 'awaiting-photo-approval',
        nextAction: 'Review the non-9:16 photo contact sheets, then run approve-photos and photos.',
      };
    }
    if (photos === 'ready') {
      return {
        ...base,
        editApproved,
        colorApproved,
        stage: 'ready-to-create-photos',
        nextAction: 'Run fresh master and delivery QC, then run photos.',
      };
    }
    if (photos === 'rendered') {
      return {
        ...base,
        editApproved,
        colorApproved,
        stage: 'photos-rendered',
        nextAction: 'Review the photo package and its photo QC report.',
      };
    }
    return {
      ...base,
      editApproved,
      colorApproved,
      stage: 'rendered',
      nextAction: 'Run QC for master and delivery, then review both reports.',
    };
  }
  return {
    ...base,
    editApproved,
    colorApproved,
    stage: 'ready-to-render',
    nextAction: 'Run grade, render, and qc.',
  };
};

export const getProjectStatus = async (projectPath: string): Promise<ProjectStatus> => {
  const operation = await readMediaOperation(projectPath);
  if (operation) {
    if (isMediaOperationAlive(operation)) return statusFromOperation(operation);
    if (await isMediaOperationLockActive(projectPath)) return mediaOperationStartingStatus();
    return statusFromOperation(operation);
  }

  await assertProjectScaffold(projectPath);

  const locked = await runWithStatusScanLock(projectPath, async () => {
    const operationAfterLock = await readMediaOperation(projectPath);
    if (operationAfterLock) return statusFromOperation(operationAfterLock);
    return await getProjectStatusWithoutOperation(projectPath);
  });
  if (locked.acquired) return locked.value;

  const operationAfterBusyLock = await readMediaOperation(projectPath);
  if (operationAfterBusyLock) return statusFromOperation(operationAfterBusyLock);
  if (await isMediaOperationLockActive(projectPath)) return mediaOperationStartingStatus();
  return statusScanInProgressStatus();
};
