# Philippines Travel Style Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checksum-pinned Google Fonts cache, three reusable Philippines travel style presets, explicit display/body/metadata typography, token-driven Remotion overlays, and approval-safe style fingerprints.

**Architecture:** Tracked font and style catalogs describe immutable upstream assets and visual tokens. A new `style` command materializes missing fonts into an ignored verified cache, ingests exact binaries, and writes a project-local style snapshot; render staging, rights, and fingerprints resolve only the snapshot's selected roles. Legacy projects retain deterministic zero/one-font behavior and reject ambiguous multi-font selection.

**Tech Stack:** TypeScript 5.9, Node.js 24 `fetch`, Zod 4, Commander 14, Remotion 4/React 19, Vitest 4, SHA-256, repository atomic JSON/output helpers.

**Spec:** `docs/superpowers/specs/2026-08-27-philippines-travel-style-library-design.md`

## Global Constraints

- Font downloads use only catalog-declared HTTPS URLs pinned to Google Fonts commit `ade3d1533e06b2b1462ffcde8e08b129627ca360`.
- Font binaries remain ignored under `library/fonts/`; Git tracks catalogs, metadata, schemas, tests, docs, templates, and skill guidance only.
- Applying a style never modifies exposure, white balance, tint, LUT choices, treatments, or color approval identity.
- Style changes require a new exact rough approval; unchanged exact color approval remains reusable after that approval.
- Every selected role font participates in render and rights fingerprints; unused font inputs do not.
- No Baybayin text is generated, transliterated, or inferred.
- No new user approval gate is introduced.
- Every production behavior follows RED → GREEN → REFACTOR and every changed test follows `writing-good-tests.md`.

---

## File structure

- Create `src/style/contracts.ts`: strict catalog, preset, project snapshot, palette, typography, and output-token schemas plus default cinematic snapshot.
- Create `src/style/library.ts`: catalog loading, cache status, secure bounded download, cache verification, preset resolution, and atomic project application.
- Create `src/style/project.ts`: project style loading, legacy fallback, font-source resolution, and render-role selection.
- Create `library/font-catalog.json`: immutable Google Fonts asset declarations.
- Create `library/style-catalog.json`: the three approved presets and semantic tokens.
- Create `library/fonts/.gitkeep`: tracked anchor for the ignored local font cache.
- Create `templates/reel/config/style.json`: explicit system-font cinematic default for every new project.
- Create `tests/unit/style-contracts.test.ts`: strict schema and preset invariant tests.
- Create `tests/unit/style-library.test.ts`: cache/download/application tests using real temporary files and in-memory `Response` objects.
- Create `tests/unit/project-style.test.ts`: project snapshot, legacy fallback, source resolution, rights, and render fingerprint tests.
- Create `tests/fixtures/styles/philippines-island-editorial.json`: hand-authored resolved snapshot used by renderer tests.
- Modify `src/cli.ts`, `src/commands/registry.ts`, `tests/unit/command-surface.test.ts`: `style --list` and `style <reel> --apply`.
- Modify `src/project/workspace.ts`, `tests/unit/project-workspace.test.ts`: scaffold validation and default style snapshot.
- Modify `src/render/artifacts.ts`, `src/edit/rights.ts`, `tests/unit/edit-approval.test.ts`: selected role fonts and approval semantics.
- Modify `src/render/stage.ts`, `src/remotion/model.ts`, `src/remotion/Reel.tsx`, `src/remotion/Root.tsx`: explicit staged font roles and token-driven visuals.
- Modify `tests/unit/render-stage-preparation.test.ts`, `tests/unit/remotion-data.test.ts`, `tests/unit/carousel.test.ts`: role staging/loading/render behavior.
- Modify `src/commands/doctor.ts`, `tests/integration/doctor.test.ts`, `tests/unit/doctor-workspace.test.ts`: strict tracked catalog validation and optional cache reporting.
- Modify `.gitignore`, `README.md`, `library/README.md`: cache and command documentation.
- Modify `.agents/skills/create-social-reel/SKILL.md`, `references/inputs.md`, `references/editing.md`, `references/approvals.md`, and skill eval artifacts: reusable preset orchestration.

---

### Task 1: Define strict style contracts and tracked catalogs

**Files:**
- Create: `src/style/contracts.ts`
- Create: `library/font-catalog.json`
- Create: `library/style-catalog.json`
- Create: `templates/reel/config/style.json`
- Create: `tests/unit/style-contracts.test.ts`

**Interfaces:**
- Produces: `FontCatalogSchema`, `StyleCatalogSchema`, `StyleConfigSchema`, `FontRoleSchema`, `OutputStyleTokensSchema`, `CINEMATIC_MINIMAL_STYLE`, and their inferred types.
- Consumed by: Tasks 2–7.

- [ ] **Step 1: Write failing contract tests**

Name the break: accepting mutable URLs, malformed colors, duplicate roles, unsupported weight ranges, or a preset that references an unknown font.

```ts
import {describe, expect, it} from 'vitest';
import {readJson} from '../../src/core/json';
import {
  CINEMATIC_MINIMAL_STYLE,
  FontCatalogSchema,
  StyleCatalogSchema,
  StyleConfigSchema,
} from '../../src/style/contracts';

it('parses the tracked catalogs and resolves every preset font ID', async () => {
  const fonts = FontCatalogSchema.parse(await readJson('library/font-catalog.json'));
  const styles = StyleCatalogSchema.parse(await readJson('library/style-catalog.json'));
  const ids = new Set(fonts.fonts.map((font) => font.id));
  for (const preset of styles.presets) {
    expect(Object.values(preset.typography).every((role) => ids.has(role.assetId))).toBe(true);
  }
});

it('rejects mutable or non-Google download URLs', async () => {
  const catalog = structuredClone(
    FontCatalogSchema.parse(await readJson('library/font-catalog.json')),
  );
  catalog.fonts[0].downloadUrl = 'https://fonts.example/latest.ttf';
  expect(() => FontCatalogSchema.parse(catalog)).toThrow(/pinned|Google Fonts|download/i);
});

it('rejects a project style with an invalid semantic color', () => {
  const style = structuredClone(CINEMATIC_MINIMAL_STYLE);
  style.palette.primary = 'white';
  expect(() =>
    StyleConfigSchema.parse(style),
  ).toThrow(/color|hex/i);
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npx vitest run tests/unit/style-contracts.test.ts`

Expected: FAIL because `src/style/contracts.ts` and the two catalogs do not exist.

- [ ] **Step 3: Implement schemas and the explicit cinematic default**

Use strict Zod objects. `FontCatalogSchema` has root fields `schemaVersion`, `upstreamRevision`, and `fonts`; `StyleCatalogSchema` has `schemaVersion` and `presets`. The key public shapes are:

```ts
export const FontRoleSchema = z.enum(['display', 'body', 'metadata']);

export const FontAssetSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  family: z.string().min(1),
  style: z.enum(['normal', 'italic']),
  weight: z.union([
    z.number().int().min(100).max(900),
    z.object({min: z.number().int(), max: z.number().int()}).strict()
      .refine(({min, max}) => 100 <= min && min <= max && max <= 900),
  ]),
  roles: z.array(FontRoleSchema).nonempty(),
  scripts: z.array(z.enum(['Latin', 'Cyrillic', 'Tagalog'])).nonempty(),
  upstreamRevision: z.literal('ade3d1533e06b2b1462ffcde8e08b129627ca360'),
  downloadUrl: z.string().url().refine(isPinnedGoogleFontsRawUrl),
  cacheFile: z.string().regex(/^library\/fonts\/[a-z0-9-]+\.ttf$/),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxBytes: z.number().int().positive().max(2_000_000),
  license: z.object({
    id: z.literal('OFL-1.1'),
    copyright: z.string().min(1),
    url: z.literal('https://openfontlicense.org'),
  }).strict(),
}).strict();

export const OutputStyleTokensSchema = z.object({
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
}).strict();
```

`StyleConfigSchema` snapshots `presetId`, `catalogFingerprint`, three resolved roles (`assetId`, nullable `relativePath`, fixed safe internal `family`, weight/style, fallback list), palette (`primary`, `dark`, `coolAccent`, `warmAccent`, `humanAccent`, `earthAccent`), and `profiles.reel` / `profiles.carousel` tokens.

- [ ] **Step 4: Add exact font catalog entries**

Use these immutable assets and a `maxBytes` of `1000000`:

| ID | Download path at pinned revision | SHA-256 | Bytes | Weight |
|---|---|---|---:|---|
| `manrope-variable` | `ofl/manrope/Manrope%5Bwght%5D.ttf` | `d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40` | 165420 | 200–800 |
| `fraunces-variable` | `ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf` | `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb` | 360440 | 100–900 |
| `barlow-condensed-semibold` | `ofl/barlowcondensed/BarlowCondensed-SemiBold.ttf` | `7b619d14bc2327509a9ef32b0890f709626f7ecc9ff61191c2a4314c5499d2d9` | 109428 | 600 |
| `instrument-serif-regular` | `ofl/instrumentserif/InstrumentSerif-Regular.ttf` | `498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88` | 70012 | 400 |
| `noto-sans-tagalog-regular` | `ofl/notosanstagalog/NotoSansTagalog-Regular.ttf` | `871a66319d10d1a027eee889f75ea49be0b7d2a4e97acd6bf7f7a0ed1d741aac` | 53012 | 400 |

Use these exact catalog copyright strings from the pinned `METADATA.pb` files:

- Manrope: `Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)`
- Fraunces: `Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces)`
- Barlow Condensed: `Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow)`
- Instrument Serif: `Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)`
- Noto Sans Tagalog: `Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tagalog)`

Prefix each path with:

```text
https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/
```

Cache basenames are the normalized filenames already used in the checksum table.

- [ ] **Step 5: Add the three presets and exact shared tokens**

Use the approved palette and these profile tokens:

```json
{
  "palette": {
    "primary": "#FFF6E8",
    "dark": "#142B33",
    "coolAccent": "#287A78",
    "warmAccent": "#E7A15B",
    "humanAccent": "#C96859",
    "earthAccent": "#56382D"
  },
  "profiles": {
    "carousel": {
      "headingSize": 50,
      "bodySize": 29,
      "captionSize": 34,
      "metadataSize": 22,
      "horizontalPadding": 0.05,
      "bottomPadding": 0.076,
      "maxTextWidth": 0.62,
      "headingTrackingEm": 0.05,
      "bodyTrackingEm": 0.025,
      "headingLineHeight": 1.05,
      "bodyLineHeight": 1.15,
      "gap": 10,
      "fadeFrames": 8,
      "shadow": "0 2px 18px rgba(8,15,14,0.72)",
      "scrimOpacity": 0.28,
      "scrimHeight": 0.34
    },
    "reel": {
      "headingSize": 68,
      "bodySize": 36,
      "captionSize": 48,
      "metadataSize": 26,
      "horizontalPadding": 0.056,
      "bottomPadding": 0.076,
      "maxTextWidth": 0.7,
      "headingTrackingEm": 0.045,
      "bodyTrackingEm": 0.02,
      "headingLineHeight": 1.05,
      "bodyLineHeight": 1.15,
      "gap": 12,
      "fadeFrames": 8,
      "shadow": "0 2px 20px rgba(8,15,14,0.72)",
      "scrimOpacity": 0.3,
      "scrimHeight": 0.3
    }
  }
}
```

Typography mappings:

- island editorial: Fraunces 600 display; Manrope 450 body; Manrope 550 metadata;
- field notes: Barlow Condensed 600 display; Manrope 450 body; Manrope 550 metadata;
- postcard: Instrument Serif 400 display; Manrope 450 body; Manrope 550 metadata.

Use fixed safe renderer families `ReelDisplay`, `ReelBody`, `ReelMetadata`; the project snapshot may assign `ReelBody` to metadata when the same asset is deduplicated later.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tests/unit/style-contracts.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(style): add font and preset catalogs`

---

### Task 2: Implement secure bounded font caching

**Files:**
- Create: `src/style/library.ts`
- Create/Modify: `tests/unit/style-library.test.ts`

**Interfaces:**
- Consumes: `FontAsset`, `FontCatalogSchema` from Task 1.
- Produces: `readFontCatalog(engineRoot)`, `readStyleCatalog(engineRoot)`, `fontCacheStatus(engineRoot, asset)`, `materializeCatalogFont(engineRoot, asset, options)`.

- [ ] **Step 1: Write failing cache tests**

Name the breaks: trusting corrupt cached bytes, following an unapproved redirect, reading beyond the declared cap, or publishing a partial file after checksum failure.

```ts
it('reuses only an exact cached font', async () => {
  await writeFile(cachePath, expectedBytes);
  const fetchImpl = vi.fn();
  await expect(materializeCatalogFont(root, asset, {fetchImpl})).resolves.toBe(cachePath);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('replaces corrupt cache only after a verified download', async () => {
  await writeFile(cachePath, 'corrupt');
  const fetchImpl = vi.fn(async () => new Response(expectedBytes, {status: 200}));
  await materializeCatalogFont(root, asset, {fetchImpl});
  expect(await hashFile(cachePath)).toBe(asset.checksumSha256);
});

it('leaves the prior cache untouched when downloaded bytes exceed the cap', async () => {
  await writeFile(cachePath, 'prior-corrupt-cache');
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(asset.maxBytes + 1), {status: 200}));
  await expect(materializeCatalogFont(root, asset, {fetchImpl})).rejects.toThrow(/maximum|bytes/i);
  expect(await readFile(cachePath, 'utf8')).toBe('prior-corrupt-cache');
});
```

- [ ] **Step 2: Run the cache tests and verify RED**

Run: `npx vitest run tests/unit/style-library.test.ts -t "cache|download|redirect|bytes"`

Expected: FAIL because the library functions do not exist.

- [ ] **Step 3: Implement allowlisted redirects and bounded streaming**

```ts
export type FontDownloadOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const assertAllowedFontUrl = (input: string, revision: string): URL => {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'raw.githubusercontent.com' ||
    url.pathname.split('/').slice(1, 4).join('/') !== `google/fonts/${revision}`
  ) throw new Error(`Font URL is outside the pinned Google Fonts source: ${input}`);
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
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
};
```

Fetch with `redirect: 'manual'`, allow at most five redirects, validate every `Location`, and use `AbortSignal.timeout(options.timeoutMs ?? 30_000)`.

- [ ] **Step 4: Implement atomic checksum-pinned cache publication**

Write to a unique sibling temporary path, verify size and SHA-256, then rename over the cache path. Always remove the temporary path on failure. Never unlink the existing cache before verified replacement bytes exist.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/unit/style-library.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(style): add verified font cache`

---

### Task 3: Apply presets atomically and expose the CLI

**Files:**
- Modify: `src/style/library.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/registry.ts`
- Modify: `src/project/workspace.ts`
- Modify: `tests/unit/style-library.test.ts`
- Modify: `tests/unit/command-surface.test.ts`
- Modify: `tests/unit/project-workspace.test.ts`

**Interfaces:**
- Produces: `ApplyStyleOptions = {materialize?: typeof materializeCatalogFont}`, `listStyleLibrary(engineRoot)`, `applyStylePreset(projectPath, engineRoot, presetId, options)` returning `{presetId, installed, unchanged, analysisRequired: true}`.
- Consumes: `ingestFiles(projectPath, paths, 'fonts')`, `writeJson`, Task 1 schemas, Task 2 materializer.

- [ ] **Step 1: Write failing application and command tests**

```ts
it('applies one preset snapshot after ingesting each distinct role asset once', async () => {
  const fontFixturePath = (id: string) => path.join(fontFixtureRoot, `${id}.ttf`);
  await Promise.all([
    writeFile(fontFixturePath('fraunces-variable'), 'fraunces-fixture'),
    writeFile(fontFixturePath('manrope-variable'), 'manrope-fixture'),
  ]);
  const result = await applyStylePreset(projectPath, engineRoot, 'philippines-island-editorial', {
    materialize: async (_root, asset) => fontFixturePath(asset.id),
  });
  const style = StyleConfigSchema.parse(await readJson(path.join(projectPath, 'config/style.json')));
  expect(result.analysisRequired).toBe(true);
  expect(style.typography.display.assetId).toBe('fraunces-variable');
  expect(style.typography.body.assetId).toBe('manrope-variable');
  expect(style.typography.metadata.assetId).toBe('manrope-variable');
  expect((await scanInputs(projectPath)).files.filter((file) => file.kind === 'fonts')).toHaveLength(2);
});

it('keeps the prior style when one required asset conflicts', async () => {
  const fontFixturePath = (id: string) => path.join(fontFixtureRoot, `${id}.ttf`);
  await mkdir(path.join(projectPath, 'input/fonts'), {recursive: true});
  await writeFile(path.join(projectPath, 'input/fonts/manrope-variable.ttf'), 'conflicting-bytes');
  const before = await readFile(stylePath, 'utf8');
  await expect(applyStylePreset(projectPath, engineRoot, 'philippines-island-editorial', {
    materialize: async (_root, asset) => fontFixturePath(asset.id),
  }))
    .rejects.toThrow(/overwrite|different bytes|conflict/i);
  expect(await readFile(stylePath, 'utf8')).toBe(before);
});
```

Update command-order expectation to insert `style` immediately after `ingest`. Assert `style --list` works without a reel name and `style <reel> --apply <id>` rejects an unknown project before mutation.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/style-library.test.ts tests/unit/command-surface.test.ts tests/unit/project-workspace.test.ts`

Expected: FAIL because apply/list, the command, and template config do not exist.

- [ ] **Step 3: Resolve a complete project snapshot**

Deduplicate preset asset IDs before materialization/ingest. Map each role to `input/fonts/${path.basename(asset.cacheFile)}` and compute:

```ts
const catalogFingerprint = hashValue({
  fontCatalogVersion: fonts.schemaVersion,
  fontRevision: fonts.upstreamRevision,
  styleCatalogVersion: styles.schemaVersion,
  preset,
  selectedFonts,
});
```

Call `ingestFiles` only after all required cache assets are valid. Write `config/style.json` only after ingest succeeds.

- [ ] **Step 4: Add the CLI**

```ts
program
  .command('style')
  .argument('[reel-name]')
  .option('--list', 'List reusable style presets and font cache state')
  .option('--apply <preset-id>', 'Apply one reusable style preset to a project')
  .action(async (reelName: string | undefined, options: {list?: boolean; apply?: string}) => {
    const {applyStylePreset, listStyleLibrary} = await import('./style/library');
    if (options.list && !reelName && !options.apply) return print(await listStyleLibrary(ENGINE_ROOT));
    if (reelName && options.apply && !options.list) {
      return print(await applyStylePreset(project(reelName), ENGINE_ROOT, options.apply));
    }
    throw new Error('Use either style --list or style <reel-name> --apply <preset-id>');
  });
```

- [ ] **Step 5: Make the explicit cinematic style part of every new scaffold**

Add `templates/reel/config/style.json`, include it in `assertProjectScaffold`, and parse it with `StyleConfigSchema` during `createReelProject` after copying the template.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tests/unit/style-library.test.ts tests/unit/command-surface.test.ts tests/unit/project-workspace.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(style): apply presets from the CLI`

---

### Task 4: Resolve selected fonts for rights and render fingerprints

**Files:**
- Create: `src/style/project.ts`
- Create: `tests/unit/project-style.test.ts`
- Modify: `src/render/artifacts.ts`
- Modify: `src/edit/rights.ts`
- Modify: `tests/unit/edit-approval.test.ts`
- Modify: `tests/unit/render-artifacts.test.ts`

**Interfaces:**
- Produces: `readProjectStyle(projectPath, sourceManifest)`, `resolveStyleFontSources(style, sourceManifest)`, `styleForRenderFingerprint(style)`.
- Changes: `referencedRenderSources(edit, sourceManifest, style)` requires the resolved style.

- [ ] **Step 1: Write failing legacy/source-resolution tests**

Name the breaks: selecting the alphabetical first of multiple fonts, omitting a selected role font from rights, or invalidating color for a style-only change.

```ts
const makeLegacyProject = async (fontPaths: string[]) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'legacy-style-'));
  await mkdir(path.join(projectPath, 'config'), {recursive: true});
  const manifest = SourceManifestSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-27T00:00:00.000Z',
    sources: fontPaths.map((relativePath, index) => ({
      id: `font-${index}`,
      relativePath,
      checksumSha256: String(index + 1).repeat(64),
      sizeBytes: 100,
      mediaType: 'font',
      ffprobe: {format: {}, streams: []},
      camera: {confirmed: false, profileId: null},
    })),
  });
  return {projectPath, manifest};
};

it.each([
  {fontPaths: [], expected: []},
  {fontPaths: ['input/fonts/only.ttf'], expected: ['input/fonts/only.ttf']},
])('resolves deterministic legacy style for $fontPaths.length fonts', async ({fontPaths, expected}) => {
  const {projectPath, manifest} = await makeLegacyProject(fontPaths);
  const style = await readProjectStyle(projectPath, manifest);
  expect(resolveStyleFontSources(style, manifest).map((source) => source.relativePath))
    .toEqual(expected);
});

it('rejects a legacy project with multiple unassigned fonts', async () => {
  const {projectPath, manifest} = await makeLegacyProject([
    'input/fonts/a.ttf',
    'input/fonts/b.ttf',
  ]);
  await expect(readProjectStyle(projectPath, manifest))
    .rejects.toThrow(/multiple|apply.*style|ambiguous/i);
});

it('includes every selected role font once and ignores unselected fonts', () => {
  const {edit, manifest, style} = explicitProjectStyleFixture({
    selected: ['input/fonts/fraunces.ttf', 'input/fonts/manrope.ttf'],
    unused: ['input/fonts/unused.ttf'],
  });
  expect(referencedRenderSources(edit, manifest, style).map((source) => source.relativePath).sort())
    .toEqual(['input/clips/clip.mp4', 'input/fonts/fraunces.ttf', 'input/fonts/manrope.ttf']);
});
```

Define `explicitProjectStyleFixture` in the test file as a test-only builder returning schema-parsed `edit`, `manifest`, and `style`; it must assign Fraunces to display, Manrope to body/metadata, and leave the supplied unused path out of all roles.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/project-style.test.ts tests/unit/render-artifacts.test.ts tests/unit/edit-approval.test.ts -t "style|font|typography"`

Expected: FAIL because style resolution and selected-role fingerprinting do not exist.

- [ ] **Step 3: Implement explicit and legacy resolution**

For a config snapshot, resolve each non-null `relativePath` to exactly one analyzed `mediaType: 'font'` entry and fail if missing or wrong-type. Deduplicate by source ID. For missing config, use system fallback for zero fonts, assign the sole font to all roles, and reject more than one.

- [ ] **Step 4: Bind style to render and rights identity**

In `expectedRenderFingerprint`, read the project style after the validated source manifest, pass it to `referencedRenderSources`, and add `style: styleForRenderFingerprint(style)` to the hashed object.

In `currentRightsAssets`, use the same resolved style and source helper. Do not include unused font inputs.

- [ ] **Step 5: Add approval behavior regression**

Build an approved fixture, apply a different typography snapshot without changing the edit or LUTs, refresh analysis and the exact preview record, then assert:

```ts
await approveEdit(projectPath, new Date('2026-08-27T02:00:00.000Z'));
await expect(readApprovalStatus(projectPath)).resolves.toEqual({
  editApproved: true,
  colorApproved: true,
});
expect(await currentRightsAssetSetFingerprint(projectPath)).not.toBe(priorRightsFingerprint);
```

The test must fail if style enters `createColorHash` or if the selected fonts do not enter rights/render identity.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tests/unit/project-style.test.ts tests/unit/render-artifacts.test.ts tests/unit/edit-approval.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(style): bind selected typography to project identity`

---

### Task 5: Stage explicit role fonts and preserve legacy render records

**Files:**
- Modify: `src/render/stage.ts`
- Modify: `src/remotion/model.ts`
- Modify: `src/remotion/Root.tsx`
- Modify: `tests/unit/render-stage-preparation.test.ts`
- Modify: `tests/unit/remotion-data.test.ts`
- Modify: `tests/unit/carousel.test.ts`

**Interfaces:**
- Produces: `StagedFontAsset`, `StagedFontRoles`, `ReelRenderProps.visualStyle`, `ReelRenderProps.fonts`.
- Retains: optional `fontUrl` only as a legacy render-record adapter until all repository fixtures migrate.

- [ ] **Step 1: Write failing role-staging tests**

```ts
it('stages two distinct binaries for three explicit roles', async () => {
  const {props} = await prepareRenderProps(projectPath, engineRoot, 'preview');
  expect(props.fonts).toEqual({
    display: expect.objectContaining({family: 'ReelDisplay', url: expect.stringMatching(/fraunces/)}),
    body: expect.objectContaining({family: 'ReelBody', url: expect.stringMatching(/manrope/)}),
    metadata: expect.objectContaining({family: 'ReelBody', url: expect.stringMatching(/manrope/)}),
  });
  const staged = Object.values(props.fonts).filter((font) => font !== null);
  expect(new Set(staged.map((font) => font.url))).toHaveLength(2);
});
```

Name the break: staging the alphabetical first font or copying the same Manrope bytes twice.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/render-stage-preparation.test.ts tests/unit/remotion-data.test.ts tests/unit/carousel.test.ts -t "font|style|role"`

Expected: FAIL because render props expose only `fontUrl`.

- [ ] **Step 3: Extend the render model**

```ts
export type StagedFontAsset = {
  url: string;
  family: 'ReelDisplay' | 'ReelBody' | 'ReelMetadata';
  weight: number;
  style: 'normal' | 'italic';
};

export type ReelRenderProps = {
  edit: EditManifest;
  media: Record<string, string>;
  music: string | null;
  captions: Caption[];
  watermark: string | null;
  trimBeforeFramesByClip?: Record<string, number>;
  visualStyle: StyleConfig;
  fonts: Record<FontRole, StagedFontAsset | null>;
  fontUrl?: string | null;
};
```

- [ ] **Step 4: Stage deduplicated selected sources**

Resolve style roles through `src/style/project.ts`. Stage each distinct source checksum once under `fonts/${path.basename(source.relativePath)}`. Assign repeated role paths the first safe internal family so body and metadata can share one loaded asset.

- [ ] **Step 5: Update defaults and fixtures, then run tests**

Update `Root.tsx` default props with `CINEMATIC_MINIMAL_STYLE` and null role assets. Keep legacy `fontUrl` conversion in one helper and cover it with the existing apostrophe URL test.

Run: `npx vitest run tests/unit/render-stage-preparation.test.ts tests/unit/remotion-data.test.ts tests/unit/carousel.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(render): stage role-based typography`

---

### Task 6: Drive Remotion overlay visuals from style tokens

**Files:**
- Modify: `src/remotion/model.ts`
- Modify: `src/remotion/Reel.tsx`
- Modify: `tests/unit/remotion-data.test.ts`

**Interfaces:**
- Produces: `fontFaceRules(fonts)`, `ensureCustomFontsLoaded(fonts)`, `styleProfileForOutput(style, output)`, `cardTextStyles(style, profile)`, token-driven `titleOpacity(frame, duration, fadeFrames)`.

- [ ] **Step 1: Write failing visual behavior tests**

Name the breaks: headings using body font, carousel using reel sizes, duplicate Manrope loads, or a hard-coded 10-frame fade.

```ts
it('uses carousel tokens and role families for card copy', () => {
  const islandStyle = StyleConfigSchema.parse(
    await readJson('tests/fixtures/styles/philippines-island-editorial.json'),
  );
  const profile = styleProfileForOutput(islandStyle, {width: 1910, height: 1000, fps: 30});
  expect(profile).toEqual(expect.objectContaining({headingSize: 50, bodySize: 29, fadeFrames: 8}));
  expect(cardTextStyles(islandStyle, profile)).toEqual(expect.objectContaining({
    heading: expect.objectContaining({fontFamily: 'ReelDisplay', color: '#FFF6E8'}),
    body: expect.objectContaining({fontFamily: 'ReelBody', fontSize: 29}),
  }));
});

it('loads each distinct role font once', () => {
  const fraunces = {url: 'jobs/test/fonts/fraunces.ttf', family: 'ReelDisplay', weight: 600, style: 'normal'} as const;
  const manrope = {url: 'jobs/test/fonts/manrope.ttf', family: 'ReelBody', weight: 450, style: 'normal'} as const;
  SocialReel({...props, fonts: {display: fraunces, body: manrope, metadata: manrope}});
  expect(vi.mocked(loadFont)).toHaveBeenCalledTimes(2);
});
```

Create `tests/fixtures/styles/philippines-island-editorial.json` by applying `StyleConfigSchema` to the exact resolved island snapshot from Task 3; this is a checked-in literal fixture, not output generated by the function under test.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/remotion-data.test.ts -t "carousel tokens|role families|distinct role font|fade"`

Expected: FAIL against hard-coded component values.

- [ ] **Step 3: Implement safe font-face generation and loading**

Generate rules only from fixed internal family enums and `JSON.stringify(staticFile(url))`. Deduplicate loads by `${family}\0${url}`. Preserve apostrophe encoding before `loadFont`.

- [ ] **Step 4: Replace component literals with the resolved profile**

Card heading uses display role; subheading and captions use body; timeline titles use display. Compute pixel padding from output width/height ratios, bound max width from `maxTextWidth`, and use the preset shadow/scrim/fade values. Keep watermark styling independent and utilitarian.

The scrim is an `AbsoluteFill` child limited to the bottom `scrimHeight` ratio with `rgba(20,43,51,<scrimOpacity>)`; it sits below text and above video.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/unit/remotion-data.test.ts tests/unit/carousel.test.ts && npm run typecheck`

Expected: PASS.

Commit: `feat(render): apply travel style tokens`

---

### Task 7: Add doctor checks and user documentation

**Files:**
- Modify: `src/commands/doctor.ts`
- Modify: `tests/integration/doctor.test.ts`
- Modify: `tests/unit/doctor-workspace.test.ts`
- Modify: `.gitignore`
- Create: `library/fonts/.gitkeep`
- Modify: `README.md`
- Modify: `library/README.md`

**Interfaces:**
- Produces: exported `styleLibraryCheck(engineRoot)` and doctor check `style-library` reporting catalog validity and `N/5` cached fonts.

- [ ] **Step 1: Write failing doctor tests**

```ts
it('passes valid catalogs when no optional font has been downloaded', async () => {
  const check = await styleLibraryCheck(repositoryRoot);
  expect(check).toEqual(expect.objectContaining({
    id: 'style-library',
    status: 'pass',
    message: expect.stringMatching(/0\/5.*cached|catalogs.*valid/i),
  }));
});

it('warns when a cached font checksum is wrong', async () => {
  const engineRoot = await copyCatalogFixtureToTemporaryRoot();
  await mkdir(path.join(engineRoot, 'library/fonts'), {recursive: true});
  await writeFile(path.join(engineRoot, 'library/fonts/manrope-variable.ttf'), 'corrupt');
  const check = await styleLibraryCheck(engineRoot);
  expect(check).toEqual(expect.objectContaining({
    id: 'style-library', status: 'warn', message: expect.stringMatching(/checksum/i),
  }));
});
```

Implement `copyCatalogFixtureToTemporaryRoot` in the test file by creating a temporary `library/` directory and copying the tracked font/style catalog JSON files into it. Do not copy cached binaries.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/integration/doctor.test.ts tests/unit/doctor-workspace.test.ts -t "style library|font catalog|cached font"`

Expected: FAIL because doctor has no style-library check.

- [ ] **Step 3: Implement offline catalog/cache validation**

Parse both tracked catalogs strictly. Missing cache files are normal and count as uncached. A present cache file with wrong bytes is `warn`. A malformed tracked catalog is `fail`. Doctor performs no network requests.

- [ ] **Step 4: Document cache and command usage**

Add `library/fonts/**/*.ttf` and a tracked `.gitkeep` exception to `.gitignore`. Document:

```text
npm run reel -- style --list
npm run reel -- style <name> --apply philippines-island-editorial
npm run reel -- analyze <name>
```

Explain that Google Fonts assets are OFL-1.1, downloads are pinned/checksummed, cached binaries are local, style changes are editorial, and color approval is unchanged unless color-relevant inputs also change.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/integration/doctor.test.ts tests/unit/doctor-workspace.test.ts && npm run typecheck`

Expected: PASS.

Commit: `docs(style): document verified travel presets`

---

### Task 8: Update and behavior-test `create-social-reel`

**Files:**
- Modify: `.agents/skills/create-social-reel/SKILL.md`
- Modify: `.agents/skills/create-social-reel/references/inputs.md`
- Modify: `.agents/skills/create-social-reel/references/editing.md`
- Modify: `.agents/skills/create-social-reel/references/approvals.md`
- Modify: `tests/skill-evals/cases.json`
- Modify: `tests/skill-evals/baseline.md`
- Modify: `tests/skill-evals/forward.md`

**Interfaces:**
- Produces: future reel runs that discover/apply named styles, report typography at rough review, keep style changes editorial-only, and avoid unverified Baybayin.

- [ ] **Step 1: Run and record the RED baseline before editing the skill**

Use a fresh-context subagent with the current skill and this read-only scenario:

```text
Use create-social-reel to plan the next safe commands for an approved clean 1.91:1 Bohol carousel. The user wants a separate captioned derivative with subtle Philippine editorial typography from the reusable library. Preserve the approved grade and rights where exact, and state what must be reviewed again. Do not execute commands.
```

Score these required behaviors independently:

- uses `variant`, not `new`;
- runs `style --list` and applies a named preset rather than choosing a filename;
- recommends `philippines-island-editorial` for quiet scenic Bohol footage;
- runs `analyze` after preset application;
- treats typography as editorial-only and requires a new rough approval;
- preserves exact color approval only when `status` confirms it;
- treats selected fonts as rights assets;
- does not invent Baybayin.

Record the verbatim baseline outcome and misses in `tests/skill-evals/baseline.md`. The expected RED is that the pre-change skill has no catalog-style commands or role guidance.

- [ ] **Step 2: Add the failing case contract**

Append the scenario and the eight `mustCover` items to `tests/skill-evals/cases.json` before editing skill prose.

- [ ] **Step 3: Make the minimal skill update**

Add one concise style paragraph to intake/workflow and put command/reference detail in `inputs.md`:

```text
npm run reel -- style --list
npm run reel -- style <name> --apply <preset-id>
```

In `editing.md`, specify named preset preservation for derivatives, role-based copy review, the default island-editorial recommendation only when the user requested styled copy and supplied no competing direction, and the verified-Baybayin boundary.

In `approvals.md`, state that style/typography changes invalidate the rough and used-font rights fingerprint but do not enter color identity.

Do not duplicate catalog tables in the skill; `style --list` remains the runtime source of truth.

- [ ] **Step 4: Validate GREEN behavior**

Run the same fresh-context scenario with the updated skill. Record the observed command sequence and approval classification in `tests/skill-evals/forward.md`.

Run:

```text
python3 /Users/rafalbagrowski/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/create-social-reel
```

Expected: validation PASS and all eight scenario behaviors present in the fresh-context result.

- [ ] **Step 5: Commit**

Commit: `docs(skill): teach reusable travel styles`

---

### Task 9: Full verification, stacked PR, and review loop

**Files:**
- Modify only files required by failures demonstrated during verification.

**Interfaces:**
- Produces: a non-draft PR based on `rafal/reel-derivative-variants` with complete verification evidence.

- [ ] **Step 1: Verify catalog bytes against official pinned URLs**

Download each asset to a temporary directory, then run `shasum -a 256` and `stat`. Expected checksums and bytes must exactly match Task 1's table. Do not copy temporary assets into Git.

- [ ] **Step 2: Run focused suites**

```text
npx vitest run tests/unit/style-contracts.test.ts tests/unit/style-library.test.ts tests/unit/project-style.test.ts tests/unit/render-stage-preparation.test.ts tests/unit/remotion-data.test.ts tests/unit/edit-approval.test.ts tests/unit/command-surface.test.ts tests/unit/project-workspace.test.ts
```

Expected: PASS with no unexpected warnings.

- [ ] **Step 3: Run the complete verifier**

Run: `npm run verify`

Expected: typecheck passes; all unit/integration tests pass; all E2E tests pass; doctor reports `ok: true`, a valid `style-library` check, and no failed checks. If sandbox process inspection produces `EPERM`, rerun the same verifier with approved process-table access and report both outcomes accurately.

- [ ] **Step 4: Inspect the final diff and branch relationship**

Run:

```text
git diff --check
git status --short
git log --oneline rafal/reel-derivative-variants..HEAD
```

Expected: no unstaged changes, no whitespace errors, and only style-library commits above PR #8's head.

- [ ] **Step 5: Push and open the stacked PR**

Push `rafal/philippines-travel-style-library` and create a non-draft PR with base `rafal/reel-derivative-variants`. The PR body must state that it is stacked on PR #8, list the three presets/five catalog fonts, explain the approval boundary, and include exact verification counts.

- [ ] **Step 6: Request Codex review and close the loop**

Comment `@codex review`, poll the review, verify every comment against the codebase, implement valid fixes with a failing regression first, reply in each inline thread, rerun proportional and full verification, and request re-review. Do not merge either PR without explicit user instruction.
