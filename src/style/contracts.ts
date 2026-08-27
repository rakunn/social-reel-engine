import {z} from 'zod';

export const GOOGLE_FONTS_REVISION = 'ade3d1533e06b2b1462ffcde8e08b129627ca360' as const;

export const FontRoleSchema = z.enum(['display', 'body', 'metadata']);
export type FontRole = z.infer<typeof FontRoleSchema>;

const HexColorSchema = z
  .string()
  .regex(/^#[A-F0-9]{6}$/i, 'Expected a six-digit hexadecimal color');

const FontWeightSchema = z.union([
  z.number().int().min(100).max(900),
  z
    .object({min: z.number().int(), max: z.number().int()})
    .strict()
    .refine(
      ({min, max}) => 100 <= min && min <= max && max <= 900,
      'Invalid font weight range',
    ),
]);

const isPinnedGoogleFontsRawUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'raw.githubusercontent.com' &&
      url.pathname.startsWith(`/google/fonts/${GOOGLE_FONTS_REVISION}/`)
    );
  } catch {
    return false;
  }
};

export const FontAssetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    family: z.string().min(1),
    style: z.enum(['normal', 'italic']),
    weight: FontWeightSchema,
    roles: z
      .array(FontRoleSchema)
      .nonempty()
      .refine((roles) => new Set(roles).size === roles.length, 'Duplicate font role'),
    scripts: z.array(z.enum(['Latin', 'Cyrillic', 'Tagalog'])).nonempty(),
    upstreamRevision: z.literal(GOOGLE_FONTS_REVISION),
    downloadUrl: z
      .string()
      .url()
      .refine(isPinnedGoogleFontsRawUrl, 'Font download must use the pinned Google Fonts URL'),
    cacheFile: z.string().regex(/^library\/fonts\/[a-z0-9-]+\.ttf$/),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    maxBytes: z.number().int().positive().max(2_000_000),
    license: z
      .object({
        id: z.literal('OFL-1.1'),
        copyright: z.string().min(1),
        url: z.literal('https://openfontlicense.org'),
      })
      .strict(),
  })
  .strict();
export type FontAsset = z.infer<typeof FontAssetSchema>;

export const FontCatalogSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    upstreamRevision: z.literal(GOOGLE_FONTS_REVISION),
    fonts: z.array(FontAssetSchema).nonempty(),
  })
  .strict()
  .refine(
    ({fonts}) => new Set(fonts.map(({id}) => id)).size === fonts.length,
    'Duplicate font asset ID',
  );
export type FontCatalog = z.infer<typeof FontCatalogSchema>;

export const PaletteSchema = z
  .object({
    primary: HexColorSchema,
    dark: HexColorSchema,
    coolAccent: HexColorSchema,
    warmAccent: HexColorSchema,
    humanAccent: HexColorSchema,
    earthAccent: HexColorSchema,
  })
  .strict();

export const OutputStyleTokensSchema = z
  .object({
    headingSize: z.number().positive(),
    bodySize: z.number().positive(),
    captionSize: z.number().positive(),
    metadataSize: z.number().positive(),
    horizontalPadding: z.number().min(0).max(0.2),
    bottomPadding: z.number().min(0).max(0.2),
    maxTextWidth: z.number().min(0.2).max(0.9),
    headingTrackingEm: z.number().min(-0.1).max(0.2),
    bodyTrackingEm: z.number().min(-0.1).max(0.2),
    headingLineHeight: z.number().min(0.8).max(2),
    bodyLineHeight: z.number().min(0.8).max(2),
    gap: z.number().nonnegative(),
    fadeFrames: z.number().int().min(1).max(30),
    shadow: z.string().min(1),
    scrimOpacity: z.number().min(0).max(0.8),
    scrimHeight: z.number().min(0).max(1),
  })
  .strict();
export type OutputStyleTokens = z.infer<typeof OutputStyleTokensSchema>;

const ProfilesSchema = z
  .object({
    reel: OutputStyleTokensSchema,
    carousel: OutputStyleTokensSchema,
  })
  .strict();

const FallbackSchema = z.array(z.string().min(1)).nonempty();
const PresetRoleSchema = z
  .object({
    assetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    weight: z.number().int().min(100).max(900),
    style: z.enum(['normal', 'italic']),
    fallback: FallbackSchema,
  })
  .strict();

export const StylePresetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    description: z.string().min(1),
    typography: z
      .object({display: PresetRoleSchema, body: PresetRoleSchema, metadata: PresetRoleSchema})
      .strict(),
    palette: PaletteSchema,
    profiles: ProfilesSchema,
  })
  .strict();

export const StyleCatalogSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    presets: z.array(StylePresetSchema).nonempty(),
  })
  .strict()
  .refine(
    ({presets}) => new Set(presets.map(({id}) => id)).size === presets.length,
    'Duplicate style preset ID',
  );
export type StyleCatalog = z.infer<typeof StyleCatalogSchema>;
export type StylePreset = z.infer<typeof StylePresetSchema>;

const RendererFamilySchema = z.enum(['ReelDisplay', 'ReelBody', 'ReelMetadata']);
export const ProjectFontRoleSchema = z
  .object({
    assetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable(),
    relativePath: z.string().regex(/^input\/fonts\/[a-zA-Z0-9._-]+\.ttf$/).nullable(),
    family: RendererFamilySchema,
    weight: z.number().int().min(100).max(900),
    style: z.enum(['normal', 'italic']),
    fallback: FallbackSchema,
  })
  .strict()
  .refine(
    ({assetId, relativePath}) => (assetId === null) === (relativePath === null),
    'Font asset and relative path must both be set or both be null',
  );

export const StyleConfigSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    presetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    typography: z
      .object({
        display: ProjectFontRoleSchema,
        body: ProjectFontRoleSchema,
        metadata: ProjectFontRoleSchema,
      })
      .strict(),
    palette: PaletteSchema,
    profiles: ProfilesSchema,
  })
  .strict();
export type StyleConfig = z.infer<typeof StyleConfigSchema>;

const sharedTokens = {
  headingTrackingEm: 0.045,
  bodyTrackingEm: 0.02,
  headingLineHeight: 1.05,
  bodyLineHeight: 1.15,
  fadeFrames: 8,
  shadow: '0 2px 20px rgba(8,15,14,0.72)',
} as const;

const systemFallback = ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'];
export const CINEMATIC_MINIMAL_STYLE: StyleConfig = StyleConfigSchema.parse({
  schemaVersion: '1.0.0',
  presetId: 'cinematic-minimal',
  catalogFingerprint: '0'.repeat(64),
  typography: {
    display: {
      assetId: null,
      relativePath: null,
      family: 'ReelDisplay',
      weight: 700,
      style: 'normal',
      fallback: systemFallback,
    },
    body: {
      assetId: null,
      relativePath: null,
      family: 'ReelBody',
      weight: 500,
      style: 'normal',
      fallback: systemFallback,
    },
    metadata: {
      assetId: null,
      relativePath: null,
      family: 'ReelMetadata',
      weight: 500,
      style: 'normal',
      fallback: systemFallback,
    },
  },
  palette: {
    primary: '#FFFFFF',
    dark: '#142B33',
    coolAccent: '#287A78',
    warmAccent: '#E7A15B',
    humanAccent: '#C96859',
    earthAccent: '#56382D',
  },
  profiles: {
    carousel: {
      headingSize: 50,
      bodySize: 29,
      captionSize: 34,
      metadataSize: 22,
      horizontalPadding: 0.05,
      bottomPadding: 0.076,
      maxTextWidth: 0.62,
      gap: 10,
      scrimOpacity: 0.28,
      scrimHeight: 0.34,
      ...sharedTokens,
    },
    reel: {
      headingSize: 68,
      bodySize: 36,
      captionSize: 48,
      metadataSize: 26,
      horizontalPadding: 0.056,
      bottomPadding: 0.076,
      maxTextWidth: 0.7,
      gap: 12,
      scrimOpacity: 0.3,
      scrimHeight: 0.3,
      ...sharedTokens,
    },
  },
});
