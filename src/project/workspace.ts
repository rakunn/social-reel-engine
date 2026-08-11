import {access, cp, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  ReelBriefSchema,
} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {assertSafeReelName} from '../core/paths';
import {validateEdit} from '../edit/validate';
import {scanInputs} from './ingest';
import {isMediaOperationAlive, readMediaOperation, type MediaOperationRecord} from './operation';

type CreateReelProjectOptions = {
  engineRoot: string;
  projectsRoot?: string;
  reelName: string;
  title?: string;
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
  const templateBriefPath = path.join(engineRoot, 'templates/reel/brief.json');
  const brief = ReelBriefSchema.parse({
    ...(await readJson<Record<string, unknown>>(templateBriefPath)),
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
  await writeJson(editPath, {...edit, reelName: safeName});
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
    | 'media-in-progress'
    | 'interrupted-media-job';
  nextAction: string;
  inputs: number;
  editApproved: boolean;
  colorApproved: boolean;
  activity?: Pick<
    MediaOperationRecord,
    'command' | 'phase' | 'progress' | 'startedAt' | 'updatedAt' | 'finishedAt'
  >;
};

const statusActivity = (record: MediaOperationRecord) => ({
  command: record.command,
  phase: record.phase,
  progress: record.progress,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  finishedAt: record.finishedAt,
});

export const getProjectStatus = async (projectPath: string): Promise<ProjectStatus> => {
  const operation = await readMediaOperation(projectPath);
  if (operation) {
    const base = {inputs: 0, editApproved: false, colorApproved: false, activity: statusActivity(operation)};
    if (isMediaOperationAlive(operation)) {
      return {
        ...base,
        stage: 'media-in-progress',
        nextAction: `${operation.command} is running (${operation.phase}). Wait for completion before starting another media command.`,
      };
    }
    return {
      ...base,
      stage: 'interrupted-media-job',
      nextAction: `Run ${operation.command} again to replace interrupted work safely.`,
    };
  }
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
  try {
    edit = EditManifestSchema.parse(await readJson(path.join(projectPath, 'edits/edit.json')));
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
  const [master, delivery] = await Promise.all([
    readRenderArtifactFreshness(projectPath, 'master'),
    readRenderArtifactFreshness(projectPath, 'delivery'),
  ]);
  if (master.fresh && delivery.fresh) {
    return {
      ...base,
      editApproved,
      colorApproved,
      stage: 'rendered',
      nextAction: 'Run qc and review the delivery.',
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
