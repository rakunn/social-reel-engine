import {randomUUID} from 'node:crypto';
import {access, mkdir, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hashFile, hashValue} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {ingestFiles} from '../project/ingest';
import {assertProjectScaffold} from '../project/workspace';
import {
  FontCatalogSchema,
  StyleCatalogSchema,
  StyleConfigSchema,
  type FontAsset,
  type FontCatalog,
  type StyleCatalog,
  type StyleConfig,
} from './contracts';

export type FontDownloadOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ApplyStyleOptions = {
  materialize?: typeof materializeCatalogFont;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const readFontCatalog = async (engineRoot: string): Promise<FontCatalog> =>
  await readJson(path.join(engineRoot, 'library/font-catalog.json'), FontCatalogSchema);

export const readStyleCatalog = async (engineRoot: string): Promise<StyleCatalog> =>
  await readJson(path.join(engineRoot, 'library/style-catalog.json'), StyleCatalogSchema);

const assertAllowedFontUrl = (input: string, revision: string): URL => {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'raw.githubusercontent.com' ||
    !url.pathname.startsWith(`/google/fonts/${revision}/`)
  ) {
    throw new Error(`Font URL is outside the pinned Google Fonts source: ${input}`);
  }
  return url;
};

const readBoundedBody = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  if (!response.body) throw new Error('Font response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Font download exceeds maximum ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const downloadFont = async (
  asset: FontAsset,
  options: FontDownloadOptions,
): Promise<Uint8Array> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = assertAllowedFontUrl(asset.downloadUrl, asset.upstreamRevision);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === 5) throw new Error('Font download exceeded five redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Font redirect has no Location header');
      url = assertAllowedFontUrl(new URL(location, url).toString(), asset.upstreamRevision);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Font download failed with HTTP ${response.status}`);
    }
    return await readBoundedBody(response, asset.maxBytes);
  }
  throw new Error('Font download redirect loop');
};

export const fontCacheStatus = async (
  engineRoot: string,
  asset: FontAsset,
): Promise<'cached' | 'missing' | 'corrupt'> => {
  const cachePath = path.resolve(engineRoot, asset.cacheFile);
  if (!(await exists(cachePath))) return 'missing';
  const fileStat = await stat(cachePath);
  if (!fileStat.isFile() || fileStat.size > asset.maxBytes) return 'corrupt';
  return (await hashFile(cachePath)) === asset.checksumSha256 ? 'cached' : 'corrupt';
};

export const materializeCatalogFont = async (
  engineRoot: string,
  asset: FontAsset,
  options: FontDownloadOptions = {},
): Promise<string> => {
  const cachePath = path.resolve(engineRoot, asset.cacheFile);
  if ((await fontCacheStatus(engineRoot, asset)) === 'cached') return cachePath;
  const bytes = await downloadFont(asset, options);
  await mkdir(path.dirname(cachePath), {recursive: true});
  const temporaryPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes);
    const fileStat = await stat(temporaryPath);
    if (fileStat.size > asset.maxBytes) {
      throw new Error(`Font download exceeds maximum ${asset.maxBytes} bytes`);
    }
    if ((await hashFile(temporaryPath)) !== asset.checksumSha256) {
      throw new Error(`Font checksum mismatch for ${asset.id}`);
    }
    await rename(temporaryPath, cachePath);
    return cachePath;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

export const listStyleLibrary = async (engineRoot: string) => {
  const [fonts, styles] = await Promise.all([
    readFontCatalog(engineRoot),
    readStyleCatalog(engineRoot),
  ]);
  const statusById = Object.fromEntries(
    await Promise.all(
      fonts.fonts.map(async (asset) => [asset.id, await fontCacheStatus(engineRoot, asset)]),
    ),
  );
  return {
    schemaVersion: styles.schemaVersion,
    fonts: fonts.fonts.map((asset) => ({
      id: asset.id,
      family: asset.family,
      style: asset.style,
      weight: asset.weight,
      roles: asset.roles,
      scripts: asset.scripts,
      license: asset.license,
      cache: statusById[asset.id],
    })),
    presets: styles.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      typography: Object.fromEntries(
        Object.entries(preset.typography).map(([role, selection]) => [
          role,
          {
            assetId: selection.assetId,
            family: fonts.fonts.find(({id}) => id === selection.assetId)?.family,
            cache: statusById[selection.assetId],
          },
        ]),
      ),
    })),
  };
};

export const applyStylePreset = async (
  projectPath: string,
  engineRoot: string,
  presetId: string,
  options: ApplyStyleOptions = {},
) => {
  await assertProjectScaffold(projectPath);
  const [fonts, styles] = await Promise.all([
    readFontCatalog(engineRoot),
    readStyleCatalog(engineRoot),
  ]);
  const preset = styles.presets.find(({id}) => id === presetId);
  if (!preset) throw new Error(`Unknown style preset "${presetId}"`);
  const assetById = new Map(fonts.fonts.map((asset) => [asset.id, asset]));
  const selectedAssets = [...new Set(Object.values(preset.typography).map(({assetId}) => assetId))]
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is FontAsset => asset !== undefined);
  if (selectedAssets.length !== new Set(Object.values(preset.typography).map(({assetId}) => assetId)).size) {
    throw new Error(`Style preset "${presetId}" references an unknown font asset`);
  }
  const materialize = options.materialize ?? materializeCatalogFont;
  const materialized = await Promise.all(
    selectedAssets.map(async (asset) => ({asset, filePath: await materialize(engineRoot, asset)})),
  );

  for (const {filePath} of materialized) {
    const targetPath = path.join(projectPath, 'input/fonts', path.basename(filePath));
    if ((await exists(targetPath)) && (await hashFile(targetPath)) !== (await hashFile(filePath))) {
      throw new Error(
        `Refusing to overwrite existing input input/fonts/${path.basename(filePath)} with different bytes`,
      );
    }
  }
  const ingest = await ingestFiles(
    projectPath,
    materialized.map(({filePath}) => filePath),
    'fonts',
  );

  const firstFamilyByAsset = new Map<string, 'ReelDisplay' | 'ReelBody' | 'ReelMetadata'>();
  const roleFamilies = {
    display: 'ReelDisplay',
    body: 'ReelBody',
    metadata: 'ReelMetadata',
  } as const;
  const typography = Object.fromEntries(
    (['display', 'body', 'metadata'] as const).map((role) => {
      const selection = preset.typography[role];
      const asset = assetById.get(selection.assetId)!;
      const family = firstFamilyByAsset.get(asset.id) ?? roleFamilies[role];
      firstFamilyByAsset.set(asset.id, family);
      return [
        role,
        {
          ...selection,
          relativePath: `input/fonts/${path.basename(asset.cacheFile)}`,
          family,
        },
      ];
    }),
  );
  const catalogFingerprint = hashValue({
    fontCatalogVersion: fonts.schemaVersion,
    fontRevision: fonts.upstreamRevision,
    styleCatalogVersion: styles.schemaVersion,
    preset,
    selectedFonts: selectedAssets,
  });
  const snapshot: StyleConfig = StyleConfigSchema.parse({
    schemaVersion: '1.0.0',
    presetId: preset.id,
    catalogFingerprint,
    typography,
    palette: preset.palette,
    profiles: preset.profiles,
  });
  await writeJson(path.join(projectPath, 'config/style.json'), snapshot);
  return {
    presetId,
    installed: ingest.added,
    unchanged: ingest.unchanged,
    analysisRequired: true as const,
  };
};
