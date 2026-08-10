import type {Caption} from '@remotion/captions';
import {access, copyFile, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
} from '../contracts/schemas';
import {artifactFingerprint} from '../project/artifacts';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {gradeSelectedClips, type GradedClipReport} from '../media/grade';
import {
  buildProxyVideoFilter,
  generateProxies,
  type ProxyReport,
} from '../media/proxy';
import {
  preparePreviewStabilizedClip,
  type PreviewStabilizationReport,
} from '../media/preview-stabilize';
import type {ReelRenderProps} from '../remotion/model';
import {secondsToMediaFrames} from '../remotion/model';
import {readValidatedSourceManifest} from '../media/source-integrity';
import {parseCaptionContent} from '../remotion/captions';

export type StageTarget = 'preview' | 'master';

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const stageFile = async (
  source: string,
  stageRoot: string,
  relativeTarget: string,
): Promise<string> => {
  const target = resolveInside(stageRoot, relativeTarget);
  await mkdir(path.dirname(target), {recursive: true});
  if (!(await exists(target)) || (await hashFile(target)) !== (await hashFile(source))) {
    await copyFile(source, target);
  }
  return relativeTarget.split(path.sep).join('/');
};

const loadCaptions = async (
  projectPath: string,
  edit: ReturnType<typeof EditManifestSchema.parse>,
): Promise<Caption[]> => {
  if (!edit.captions) {
    return [];
  }
  const content = await readFile(resolveInside(projectPath, edit.captions.relativePath), 'utf8');
  return parseCaptionContent(content, edit.captions.format);
};

export const prepareRenderProps = async (
  projectPath: string,
  engineRoot: string,
  target: StageTarget,
): Promise<{props: ReelRenderProps; stageRoot: string; fingerprint: string}> => {
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  let proxies: ProxyReport | null = null;
  let graded: GradedClipReport | null = null;
  if (target === 'preview') {
    proxies = await generateProxies(projectPath);
  } else {
    graded = await gradeSelectedClips(projectPath);
  }
  const sources = await readValidatedSourceManifest(projectPath);
  const fingerprint = artifactFingerprint({
    target,
    edit,
    media: target === 'preview' ? proxies : graded,
  }).slice(0, 16);
  const publicRelativeRoot = `jobs/${edit.reelName}/${fingerprint}`;
  const stageRoot = path.join(engineRoot, 'public', publicRelativeRoot);
  await mkdir(stageRoot, {recursive: true});
  const media: Record<string, string> = {};
  const trimBeforeFramesByClip: Record<string, number> = {};
  let hasUnconfirmedPreview = false;
  let priorPreviewStabilization: PreviewStabilizationReport | null = null;
  const previewStabilizationItems: PreviewStabilizationReport['items'] = [];
  if (target === 'preview') {
    try {
      priorPreviewStabilization = await readJson<PreviewStabilizationReport>(
        path.join(projectPath, 'analysis/preview-stabilization.json'),
      );
    } catch {
      priorPreviewStabilization = null;
    }
  }

  for (const clip of edit.clips) {
    let sourcePath: string;
    if (target === 'preview') {
      const proxy = proxies?.items.find((item) => item.sourceId === clip.sourceId);
      if (!proxy) {
        throw new Error(`No proxy generated for source ${clip.sourceId}`);
      }
      sourcePath = resolveInside(projectPath, proxy.proxy);
      const original = sources.sources.find((source) => source.id === clip.sourceId);
      if (!original || original.mediaType !== 'video') {
        throw new Error(`No original video source found for ${clip.sourceId}`);
      }
      const stabilized = await preparePreviewStabilizedClip(
        projectPath,
        clip,
        sourcePath,
        resolveInside(projectPath, original.relativePath),
        buildProxyVideoFilter(
          projectPath,
          proxy.normalizerFile,
          proxy.maximumDimension,
        ),
        proxy.normalizerFile
          ? await hashFile(resolveInside(projectPath, proxy.normalizerFile))
          : null,
        proxy.normalization !== 'unconfirmed-watermarked',
        priorPreviewStabilization?.items.find((item) => item.clipId === clip.id),
      );
      sourcePath = stabilized.sourcePath;
      previewStabilizationItems.push(stabilized.item);
      trimBeforeFramesByClip[clip.id] =
        stabilized.item.stabilization === 'applied'
          ? 0
          : secondsToMediaFrames(clip.inSeconds, edit.output.fps);
      hasUnconfirmedPreview ||= proxy.normalization === 'unconfirmed-watermarked';
    } else {
      const item = graded?.items.find((candidate) => candidate.clipId === clip.id);
      if (!item) {
        throw new Error(`No graded intermediate generated for clip ${clip.id}`);
      }
      sourcePath = resolveInside(projectPath, item.path);
      trimBeforeFramesByClip[clip.id] = 0;
    }
    const extension = path.extname(sourcePath).toLowerCase() || '.mov';
    const staged = await stageFile(sourcePath, stageRoot, `media/${clip.id}${extension}`);
    media[clip.id] = `${publicRelativeRoot}/${staged}`;
  }

  let music: string | null = null;
  if (edit.music) {
    const musicSource = sources.sources.find((source) => source.id === edit.music?.sourceId);
    if (!musicSource || musicSource.mediaType !== 'audio') {
      throw new Error(`Music source ${edit.music.sourceId} is missing`);
    }
    const input = resolveInside(projectPath, musicSource.relativePath);
    const staged = await stageFile(input, stageRoot, `music/${path.basename(input)}`);
    music = `${publicRelativeRoot}/${staged}`;
  }

  let fontUrl: string | null = null;
  const fontSource = sources.sources
    .filter(
      (source) =>
        source.mediaType === 'font' && /\.(woff2?|ttf|otf)$/i.test(source.relativePath),
    )
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))[0];
  if (fontSource) {
    const font = resolveInside(projectPath, fontSource.relativePath);
    const staged = await stageFile(font, stageRoot, `fonts/${path.basename(font)}`);
    fontUrl = `${publicRelativeRoot}/${staged}`;
  }

  const props: ReelRenderProps = {
    edit,
    media,
    music,
    captions: await loadCaptions(projectPath, edit),
    watermark: hasUnconfirmedPreview ? 'UNNORMALIZED LOG PREVIEW - NOT FOR EXPORT' : null,
    trimBeforeFramesByClip,
    fontUrl,
  };
  if (target === 'preview') {
    await writeJson(path.join(projectPath, 'analysis/preview-stabilization.json'), {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      items: previewStabilizationItems,
    } satisfies PreviewStabilizationReport);
  }
  await writeJson(path.join(projectPath, `analysis/render-stage-${target}.json`), {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    fingerprint,
    publicRelativeRoot,
    props,
  });
  return {props, stageRoot, fingerprint};
};
