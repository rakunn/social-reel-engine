import type {Caption} from '@remotion/captions';
import {readFile} from 'node:fs/promises';
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
import {
  createSourceIntegrityContext,
  readValidatedSourceManifest,
  type SourceIntegrityContext,
} from '../media/source-integrity';
import {parseCaptionContent} from '../remotion/captions';
import {
  prepareFreshRenderStage,
  removeRenderStage,
  renderStageRoot,
  stageImmutableFile,
} from './scratch';
import {readProjectStyle, resolveStyleFontSources} from '../style/project';
import type {FontRole} from '../style/contracts';

export type StageTarget = 'preview' | 'master';

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
  options: {
    integrity?: SourceIntegrityContext;
    onProgress?: (progress: {completed: number; total: number; label: string}) => Promise<void> | void;
  } = {},
): Promise<{props: ReelRenderProps; stageRoot: string; fingerprint: string}> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  let proxies: ProxyReport | null = null;
  let graded: GradedClipReport | null = null;
  if (target === 'preview') {
    proxies = await generateProxies(projectPath, new Date(), {
      integrity,
      onProgress: options.onProgress,
    });
  } else {
    graded = await gradeSelectedClips(projectPath, new Date(), {
      integrity,
      onProgress: options.onProgress,
    });
  }
  const sources = await readValidatedSourceManifest(projectPath, integrity);
  const visualStyle = await readProjectStyle(projectPath, sources);
  const fingerprint = artifactFingerprint({
    target,
    edit,
    media: target === 'preview' ? proxies : graded,
    visualStyle,
  }).slice(0, 16);
  const publicRelativeRoot = `jobs/${edit.reelName}/${fingerprint}`;
  const stageRoot = renderStageRoot(engineRoot, edit.reelName, fingerprint);
  await prepareFreshRenderStage(engineRoot, edit.reelName, stageRoot);
  try {
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
      let sourceChecksumSha256: string | undefined;
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
          {detectionSourceChecksumSha256: original.checksumSha256},
        );
        sourcePath = stabilized.sourcePath;
        sourceChecksumSha256 = stabilized.item.checksumSha256 ?? undefined;
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
        sourceChecksumSha256 = item.checksumSha256;
        trimBeforeFramesByClip[clip.id] = 0;
      }
      const extension = path.extname(sourcePath).toLowerCase() || '.mov';
      const staged = await stageImmutableFile(
        sourcePath,
        stageRoot,
        `media/${clip.id}${extension}`,
        sourceChecksumSha256,
      );
      media[clip.id] = staged;
    }

    let music: string | null = null;
    if (edit.music) {
      const musicSource = sources.sources.find((source) => source.id === edit.music?.sourceId);
      if (!musicSource || musicSource.mediaType !== 'audio') {
        throw new Error(`Music source ${edit.music.sourceId} is missing`);
      }
      const input = resolveInside(projectPath, musicSource.relativePath);
      const staged = await stageImmutableFile(
        input,
        stageRoot,
        `music/${path.basename(input)}`,
        musicSource.checksumSha256,
        {copy: true},
      );
      music = staged;
    }

    const stagedBySourceId = new Map<string, string>();
    for (const source of resolveStyleFontSources(visualStyle, sources)) {
      const font = resolveInside(projectPath, source.relativePath);
      stagedBySourceId.set(
        source.id,
        await stageImmutableFile(
          font,
          stageRoot,
          `fonts/${path.basename(font)}`,
          source.checksumSha256,
        ),
      );
    }
    const fonts = Object.fromEntries(
      (['display', 'body', 'metadata'] as FontRole[]).map((role) => {
        const selection = visualStyle.typography[role];
        if (!selection.relativePath) return [role, null];
        const source = sources.sources.find(
          (candidate) => candidate.relativePath === selection.relativePath,
        );
        if (!source) throw new Error(`Selected style font is missing: ${selection.relativePath}`);
        return [
          role,
          {
            url: stagedBySourceId.get(source.id)!,
            family: selection.family,
            weight: selection.weight,
            style: selection.style,
          },
        ];
      }),
    ) as ReelRenderProps['fonts'];

    const props: ReelRenderProps = {
      edit,
      media,
      music,
      captions: await loadCaptions(projectPath, edit),
      watermark: hasUnconfirmedPreview ? 'UNNORMALIZED LOG PREVIEW - NOT FOR EXPORT' : null,
      trimBeforeFramesByClip,
      visualStyle,
      fonts,
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
  } catch (error) {
    try {
      await removeRenderStage(engineRoot, stageRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Render-stage preparation failed and its partial stage could not be removed',
      );
    }
    throw error;
  }
};
