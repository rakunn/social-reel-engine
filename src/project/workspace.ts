import {access, cp, mkdir, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  ReelBriefSchema,
} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {assertSafeReelName} from '../core/paths';

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
    | 'awaiting-edit-approval'
    | 'awaiting-color-approval'
    | 'ready-to-render'
    | 'rendered';
  nextAction: string;
  inputs: number;
  editApproved: boolean;
  colorApproved: boolean;
};

const countFiles = async (directory: string): Promise<number> => {
  const entries = await readdir(directory, {withFileTypes: true});
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).length;
};

export const getProjectStatus = async (projectPath: string): Promise<ProjectStatus> => {
  const inputs = await countFiles(path.join(projectPath, 'input/clips'));
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
  let edit;
  try {
    edit = EditManifestSchema.parse(await readJson(path.join(projectPath, 'edits/edit.json')));
  } catch {
    return {...base, stage: 'awaiting-edit', nextAction: 'Create and validate edits/edit.json.'};
  }
  ApprovalStateSchema.parse(await readJson(path.join(projectPath, 'analysis/approvals.json')));
  const {readApprovalStatus} = await import('../edit/approve');
  const {editApproved, colorApproved} = await readApprovalStatus(projectPath);
  if (!editApproved) {
    return {...base, stage: 'awaiting-edit-approval', nextAction: 'Review the rough cut, then run approve-edit.'};
  }
  if (!colorApproved) {
    return {
      ...base,
      editApproved,
      stage: 'awaiting-color-approval',
      nextAction: 'Review graded reference frames, then run approve-color.',
    };
  }
  const {readRenderArtifactFreshness} = await import('../render/artifacts');
  const delivery = await readRenderArtifactFreshness(projectPath, 'delivery');
  if (delivery.fresh) {
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
