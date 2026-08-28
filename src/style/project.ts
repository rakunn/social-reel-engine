import path from 'node:path';
import type {SourceEntry, SourceManifest} from '../contracts/schemas';
import {hashValue} from '../core/hash';
import {readJson} from '../core/json';
import {
  CINEMATIC_MINIMAL_STYLE,
  StyleConfigSchema,
  type StyleConfig,
} from './contracts';

const renderableFonts = (sourceManifest: SourceManifest): SourceEntry[] =>
  sourceManifest.sources.filter(
    (source) =>
      source.mediaType === 'font' && /\.(?:woff2?|ttf|otf)$/i.test(source.relativePath),
  );

const legacyStyle = (font: SourceEntry | undefined): StyleConfig => {
  if (!font) return CINEMATIC_MINIMAL_STYLE;
  const role = {
    assetId: 'legacy-custom-font',
    relativePath: font.relativePath,
    family: 'ReelDisplay' as const,
    weight: 500,
    style: 'normal' as const,
    fallback: ['Arial', 'sans-serif'],
  };
  return StyleConfigSchema.parse({
    ...CINEMATIC_MINIMAL_STYLE,
    presetId: 'legacy-custom-font',
    catalogFingerprint: hashValue({
      legacyFont: {relativePath: font.relativePath, checksumSha256: font.checksumSha256},
    }),
    typography: {display: role, body: role, metadata: role},
  });
};

export const readProjectStyle = async (
  projectPath: string,
  sourceManifest: SourceManifest,
): Promise<StyleConfig> => {
  try {
    const style = await readJson(path.join(projectPath, 'config/style.json'), StyleConfigSchema);
    resolveStyleFontSources(style, sourceManifest);
    return style;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fonts = renderableFonts(sourceManifest);
  if (fonts.length > 1) {
    throw new Error(
      'Legacy project has multiple ambiguous fonts; apply a named style preset before rendering',
    );
  }
  return legacyStyle(fonts[0]);
};

export const resolveStyleFontSources = (
  style: StyleConfig,
  sourceManifest: SourceManifest,
): SourceEntry[] => {
  const selected = new Map<string, SourceEntry>();
  for (const role of Object.values(style.typography)) {
    if (!role.relativePath) continue;
    const source = sourceManifest.sources.find(
      (candidate) => candidate.relativePath === role.relativePath,
    );
    if (!source) {
      throw new Error(
        `Selected style font is missing from source analysis: ${role.relativePath}. Run analyze again.`,
      );
    }
    if (source.mediaType !== 'font') {
      throw new Error(`Selected style path is not an analyzed font: ${role.relativePath}`);
    }
    selected.set(source.id, source);
  }
  return [...selected.values()];
};

export const styleForRenderFingerprint = (style: StyleConfig): StyleConfig =>
  StyleConfigSchema.parse(style);
