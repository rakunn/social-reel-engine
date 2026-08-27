import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {hashFile} from '../../src/core/hash';
import {readJson} from '../../src/core/json';
import {createReelProject} from '../../src/project/workspace';
import {scanInputs} from '../../src/project/ingest';
import {StyleConfigSchema, type FontAsset} from '../../src/style/contracts';
import {
  applyStylePreset,
  assertStyleCatalogFontCompatibility,
  listStyleLibrary,
  materializeCatalogFont,
  readFontCatalog,
  readStyleCatalog,
} from '../../src/style/library';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const expectedBytes = new TextEncoder().encode('verified-font-fixture');
const fixtureAsset: FontAsset = {
  id: 'fixture-font',
  family: 'Fixture Font',
  style: 'normal',
  weight: 400,
  roles: ['display'],
  scripts: ['Latin'],
  upstreamRevision: 'ade3d1533e06b2b1462ffcde8e08b129627ca360',
  downloadUrl:
    'https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl/fixture/Fixture.ttf',
  cacheFile: 'library/fonts/fixture-font.ttf',
  checksumSha256: createHash('sha256').update(expectedBytes).digest('hex'),
  maxBytes: 100,
  license: {id: 'OFL-1.1', copyright: 'Fixture copyright', url: 'https://openfontlicense.org'},
};

describe('style library', () => {
  it.each([
    {
      name: 'unsupported role',
      mutate: (fonts: Awaited<ReturnType<typeof readFontCatalog>>, styles: Awaited<ReturnType<typeof readStyleCatalog>>) => {
        const selection = styles.presets[0].typography.display;
        fonts.fonts.find(({id}) => id === selection.assetId)!.roles = ['body'];
      },
      error: /role|display/i,
    },
    {
      name: 'mismatched style',
      mutate: (_fonts: Awaited<ReturnType<typeof readFontCatalog>>, styles: Awaited<ReturnType<typeof readStyleCatalog>>) => {
        styles.presets[0].typography.display.style = 'italic';
      },
      error: /font style|italic/i,
    },
    {
      name: 'mismatched fixed weight',
      mutate: (fonts: Awaited<ReturnType<typeof readFontCatalog>>, styles: Awaited<ReturnType<typeof readStyleCatalog>>) => {
        const selection = styles.presets[0].typography.display;
        fonts.fonts.find(({id}) => id === selection.assetId)!.weight = 400;
      },
      error: /weight/i,
    },
    {
      name: 'weight outside a variable range',
      mutate: (fonts: Awaited<ReturnType<typeof readFontCatalog>>, styles: Awaited<ReturnType<typeof readStyleCatalog>>) => {
        const selection = styles.presets[0].typography.display;
        fonts.fonts.find(({id}) => id === selection.assetId)!.weight = {min: 100, max: 400};
      },
      error: /weight|range/i,
    },
  ])('rejects a preset selection with $name', async ({mutate, error}) => {
    const fonts = structuredClone(await readFontCatalog(repositoryRoot));
    const styles = structuredClone(await readStyleCatalog(repositoryRoot));
    mutate(fonts, styles);
    expect(() => assertStyleCatalogFontCompatibility(fonts, styles)).toThrow(error);
  });

  it('lists every catalog font with cache, script, role, and license metadata', async () => {
    const listing = await listStyleLibrary(repositoryRoot);
    expect(listing.fonts).toHaveLength(5);
    expect(listing.fonts).toContainEqual(
      expect.objectContaining({
        id: 'noto-sans-tagalog-regular',
        scripts: ['Tagalog'],
        roles: ['display', 'body', 'metadata'],
        license: expect.objectContaining({id: 'OFL-1.1'}),
        cache: expect.stringMatching(/^(cached|missing|corrupt)$/),
      }),
    );
  });

  it('reuses only an exact cached font', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'style-cache-'));
    const cachePath = path.join(root, fixtureAsset.cacheFile);
    await mkdir(path.dirname(cachePath), {recursive: true});
    await writeFile(cachePath, expectedBytes);
    const fetchImpl = vi.fn();
    await expect(materializeCatalogFont(root, fixtureAsset, {fetchImpl})).resolves.toBe(cachePath);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replaces corrupt cache only after a verified download', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'style-cache-'));
    const cachePath = path.join(root, fixtureAsset.cacheFile);
    await mkdir(path.dirname(cachePath), {recursive: true});
    await writeFile(cachePath, 'corrupt');
    const fetchImpl = vi.fn(async () => new Response(expectedBytes, {status: 200}));
    await materializeCatalogFont(root, fixtureAsset, {fetchImpl});
    expect(await hashFile(cachePath)).toBe(fixtureAsset.checksumSha256);
  });

  it('leaves the prior cache untouched when downloaded bytes exceed the cap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'style-cache-'));
    const cachePath = path.join(root, fixtureAsset.cacheFile);
    await mkdir(path.dirname(cachePath), {recursive: true});
    await writeFile(cachePath, 'prior-corrupt-cache');
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(fixtureAsset.maxBytes + 1), {status: 200}),
    );
    await expect(materializeCatalogFont(root, fixtureAsset, {fetchImpl})).rejects.toThrow(
      /maximum|bytes/i,
    );
    expect(await readFile(cachePath, 'utf8')).toBe('prior-corrupt-cache');
  });

  it('rejects redirects outside the pinned Google Fonts source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'style-cache-'));
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {status: 302, headers: {location: 'https://example.com/font.ttf'}}),
    );
    await expect(materializeCatalogFont(root, fixtureAsset, {fetchImpl})).rejects.toThrow(
      /pinned|Google Fonts/i,
    );
  });

  it('applies one preset snapshot after ingesting each distinct role asset once', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'style-apply-'));
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(temporaryRoot, 'projects'),
      reelName: 'styled-project',
    });
    const fontFixtureRoot = path.join(temporaryRoot, 'font-fixtures');
    await mkdir(fontFixtureRoot, {recursive: true});
    const fontFixturePath = (id: string) => path.join(fontFixtureRoot, `${id}.ttf`);
    await Promise.all([
      writeFile(fontFixturePath('fraunces-variable'), 'fraunces-fixture'),
      writeFile(fontFixturePath('manrope-variable'), 'manrope-fixture'),
    ]);
    const result = await applyStylePreset(
      projectPath,
      repositoryRoot,
      'philippines-island-editorial',
      {materialize: async (_root, asset) => fontFixturePath(asset.id)},
    );
    const style = StyleConfigSchema.parse(
      await readJson(path.join(projectPath, 'config/style.json')),
    );
    expect(result.analysisRequired).toBe(true);
    expect(style.typography.display.assetId).toBe('fraunces-variable');
    expect(style.typography.body.assetId).toBe('manrope-variable');
    expect(style.typography.metadata.assetId).toBe('manrope-variable');
    expect(style.typography.metadata.family).toBe('ReelBody');
    expect((await scanInputs(projectPath)).files.filter((file) => file.kind === 'fonts')).toHaveLength(2);
  });

  it('keeps the prior style when one required asset conflicts', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'style-conflict-'));
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(temporaryRoot, 'projects'),
      reelName: 'conflict-project',
    });
    const fontFixtureRoot = path.join(temporaryRoot, 'font-fixtures');
    await mkdir(fontFixtureRoot, {recursive: true});
    const fontFixturePath = (id: string) => path.join(fontFixtureRoot, `${id}.ttf`);
    await writeFile(fontFixturePath('fraunces-variable'), 'fraunces-fixture');
    await writeFile(fontFixturePath('manrope-variable'), 'manrope-fixture');
    await writeFile(path.join(projectPath, 'input/fonts/manrope-variable.ttf'), 'conflict');
    const stylePath = path.join(projectPath, 'config/style.json');
    const before = await readFile(stylePath, 'utf8');
    await expect(
      applyStylePreset(projectPath, repositoryRoot, 'philippines-island-editorial', {
        materialize: async (_root, asset) => fontFixturePath(asset.id),
      }),
    ).rejects.toThrow(/overwrite|different bytes|conflict/i);
    expect(await readFile(stylePath, 'utf8')).toBe(before);
    await expect(access(path.join(projectPath, 'input/fonts/fraunces-variable.ttf'))).rejects.toThrow();
  });
});
