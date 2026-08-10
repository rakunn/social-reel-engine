import {access, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {LutDefinitionsSchema, type LutDefinition} from '../contracts/schemas';
import {artifactFingerprint, type ArtifactIndex} from '../project/artifacts';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {analyzeSources} from './analyze';
import {runFfmpeg} from './ffmpeg';
import {hashFile} from '../core/hash';
import {lutCompatibilityFailures} from '../core/lut-compatibility';
import {pipelineBuildFingerprint} from '../render/artifacts';
import {escapeFfmpegFilterValue} from './filter-escape';
import {REC709_OUTPUT_METADATA_ARGS} from './color-ffmpeg';

export type ProxyItem = {
  sourceId: string;
  proxy: string;
  representativeFrame: string;
  contactSheet: string;
  normalization: 'technical' | 'combined' | 'unconfirmed-watermarked';
  normalizerFile: string | null;
  maximumDimension: number;
  cached: boolean;
};

export type ProxyReport = {
  schemaVersion: '1.0.0';
  generatedAt: string;
  items: ProxyItem[];
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readArtifactIndex = async (projectPath: string): Promise<ArtifactIndex> => {
  try {
    return await readJson<ArtifactIndex>(path.join(projectPath, 'analysis/artifacts.json'));
  } catch {
    return {schemaVersion: '1.0.0', artifacts: {}};
  }
};

const loadLuts = async (projectPath: string): Promise<LutDefinition[]> => {
  const config = await readJson<{luts?: unknown[]}>(path.join(projectPath, 'config/luts.json'));
  return LutDefinitionsSchema.parse(config.luts ?? []);
};

const durationOf = (source: {
  ffprobe: {format?: Record<string, unknown>; streams?: Array<Record<string, unknown>>};
}): number => {
  const video = source.ffprobe.streams?.find((stream) => stream.codec_type === 'video');
  const videoDuration = Number(video?.duration);
  if (Number.isFinite(videoDuration) && videoDuration > 0) {
    return videoDuration;
  }
  const duration = Number(source.ffprobe.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
};

const cachedFilesAreValid = async (
  projectPath: string,
  record: ArtifactIndex['artifacts'][string] | undefined,
  expectedFiles: string[],
): Promise<boolean> => {
  if (!record?.checksums || record.files.length !== expectedFiles.length) {
    return false;
  }
  for (const file of expectedFiles) {
    const filePath = resolveInside(projectPath, file);
    if (
      !record.files.includes(file) ||
      !(await fileExists(filePath)) ||
      (await hashFile(filePath)) !== record.checksums[file]
    ) {
      return false;
    }
  }
  return true;
};

export const buildProxyVideoFilter = (
  projectPath: string,
  normalizerFile: string | null,
  maximumDimension: number,
): string => {
  const baseScale =
    `scale='if(gt(iw,ih),${maximumDimension},-2)':` +
    `'if(gt(iw,ih),-2,${maximumDimension})'`;
  return normalizerFile
    ? `format=gbrp16le,` +
        `lut3d=file=${escapeFfmpegFilterValue(resolveInside(projectPath, normalizerFile))},` +
        'zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited:' +
        `matrixin=gbr:transferin=bt709:primariesin=bt709,${baseScale}`
    : `${baseScale},drawbox=x=0:y=ih-100:w=iw:h=100:color=black@0.72:t=fill,` +
        "drawtext=text='UNNORMALIZED LOG PREVIEW - PROFILE NOT CONFIRMED':fontcolor=white:fontsize=h/28:x=(w-text_w)/2:y=h-66";
};

export const generateProxies = async (
  projectPath: string,
  now = new Date(),
): Promise<ProxyReport> => {
  const manifest = await analyzeSources(projectPath, now);
  const luts = await loadLuts(projectPath);
  const settings = await readJson<{
    proxy: {width: number; height: number; crf: number};
  }>(path.join(projectPath, 'config/settings.json'));
  const maximumDimension = Math.max(settings.proxy.width, settings.proxy.height);
  if (
    !Number.isInteger(maximumDimension) ||
    maximumDimension < 2 ||
    !Number.isInteger(settings.proxy.crf) ||
    settings.proxy.crf < 0 ||
    settings.proxy.crf > 51
  ) {
    throw new Error('config/settings.json contains invalid proxy dimensions or CRF');
  }
  const artifacts = await readArtifactIndex(projectPath);
  const pipelineBuild = await pipelineBuildFingerprint();
  const items: ProxyItem[] = [];
  await Promise.all(
    ['work/proxies', 'analysis/frames', 'analysis/contact-sheets'].map((directory) =>
      mkdir(path.join(projectPath, directory), {recursive: true}),
    ),
  );

  for (const source of manifest.sources.filter((entry) => entry.mediaType === 'video')) {
    const matching = source.camera.confirmed
      ? luts.filter(
          (lut) =>
            (lut.kind === 'technical' || lut.kind === 'combined') &&
            lutCompatibilityFailures(source, lut).length === 0,
        )
      : [];
    const normalizer = matching.length === 1 ? matching[0] : null;
    if (normalizer) {
      const normalizerPath = resolveInside(projectPath, normalizer.file);
      if (!(await fileExists(normalizerPath))) {
        throw new Error(`Configured proxy normalization LUT is missing: ${normalizer.file}`);
      }
      if ((await hashFile(normalizerPath)) !== normalizer.checksumSha256) {
        throw new Error(`Configured proxy normalization LUT checksum is stale: ${normalizer.file}`);
      }
    }
    const normalization: ProxyItem['normalization'] = normalizer
      ? normalizer.kind === 'combined'
        ? 'combined'
        : 'technical'
      : 'unconfirmed-watermarked';
    const fingerprint = artifactFingerprint({
      version: 1,
      pipelineBuild,
      source: source.checksumSha256,
      camera: source.camera,
      normalizer,
      proxy: settings.proxy,
    });
    const key = `proxy:${source.id}`;
    const proxy = `work/proxies/${source.id}.mp4`;
    const representativeFrame = `analysis/frames/${source.id}.jpg`;
    const contactSheet = `analysis/contact-sheets/${source.id}.jpg`;
    const relativeFiles = [proxy, representativeFrame, contactSheet];
    const cached =
      artifacts.artifacts[key]?.fingerprint === fingerprint &&
      (await cachedFilesAreValid(projectPath, artifacts.artifacts[key], relativeFiles));
    if (!cached) {
      const inputPath = resolveInside(projectPath, source.relativePath);
      const proxyPath = resolveInside(projectPath, proxy);
      const videoFilter = buildProxyVideoFilter(
        projectPath,
        normalizer?.file ?? null,
        maximumDimension,
      );
      await runFfmpeg([
        '-i',
        inputPath,
        '-vf',
        videoFilter,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        String(settings.proxy.crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        ...(normalizer ? REC709_OUTPUT_METADATA_ARGS : []),
        '-movflags',
        '+faststart',
        proxyPath,
      ]);
      const stillTimestamp = Math.max(0, durationOf(source) * 0.45);
      await runFfmpeg([
        '-ss',
        stillTimestamp.toFixed(3),
        '-i',
        proxyPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        resolveInside(projectPath, representativeFrame),
      ]);
      await runFfmpeg([
        '-i',
        proxyPath,
        '-vf',
        `fps=${Math.min(8, Math.max(0.01, 8 / durationOf(source))).toFixed(6)},` +
          'scale=320:-2,tile=4x2:padding=4:margin=4:color=black',
        '-frames:v',
        '1',
        '-q:v',
        '3',
        resolveInside(projectPath, contactSheet),
      ]);
      artifacts.artifacts[key] = {
        fingerprint,
        generatedAt: now.toISOString(),
        files: relativeFiles,
        checksums: Object.fromEntries(
          await Promise.all(
            relativeFiles.map(async (file) => [
              file,
              await hashFile(resolveInside(projectPath, file)),
            ]),
          ),
        ),
      };
    }
    items.push({
      sourceId: source.id,
      proxy,
      representativeFrame,
      contactSheet,
      normalization,
      normalizerFile: normalizer?.file ?? null,
      maximumDimension,
      cached,
    });
  }

  await writeJson(path.join(projectPath, 'analysis/artifacts.json'), artifacts);
  const report: ProxyReport = {schemaVersion: '1.0.0', generatedAt: now.toISOString(), items};
  await writeJson(path.join(projectPath, 'analysis/proxies.json'), report);
  return report;
};
