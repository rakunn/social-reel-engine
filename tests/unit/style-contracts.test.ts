import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {readJson} from '../../src/core/json';
import {
  CINEMATIC_MINIMAL_STYLE,
  FontCatalogSchema,
  StyleCatalogSchema,
  StyleConfigSchema,
} from '../../src/style/contracts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

describe('style contracts', () => {
  it('parses the tracked catalogs and resolves every preset font ID', async () => {
    const fonts = FontCatalogSchema.parse(
      await readJson(path.join(repositoryRoot, 'library/font-catalog.json')),
    );
    const styles = StyleCatalogSchema.parse(
      await readJson(path.join(repositoryRoot, 'library/style-catalog.json')),
    );
    const ids = new Set(fonts.fonts.map((font) => font.id));
    for (const preset of styles.presets) {
      expect(Object.values(preset.typography).every((role) => ids.has(role.assetId))).toBe(true);
    }
  });

  it('rejects mutable or non-Google download URLs', async () => {
    const catalog = structuredClone(
      FontCatalogSchema.parse(
        await readJson(path.join(repositoryRoot, 'library/font-catalog.json')),
      ),
    );
    catalog.fonts[0].downloadUrl = 'https://fonts.example/latest.ttf';
    expect(() => FontCatalogSchema.parse(catalog)).toThrow(/pinned|Google Fonts|download/i);
  });

  it('rejects a project style with an invalid semantic color', () => {
    const style = structuredClone(CINEMATIC_MINIMAL_STYLE);
    style.palette.primary = 'white';
    expect(() => StyleConfigSchema.parse(style)).toThrow(/color|hex/i);
  });

  it('rejects duplicate font roles and unsupported weight ranges', async () => {
    const catalog = structuredClone(
      FontCatalogSchema.parse(
        await readJson(path.join(repositoryRoot, 'library/font-catalog.json')),
      ),
    );
    catalog.fonts[0].roles = ['body', 'body'];
    expect(() => FontCatalogSchema.parse(catalog)).toThrow(/duplicate/i);
    catalog.fonts[0].roles = ['body'];
    catalog.fonts[0].weight = {min: 900, max: 100};
    expect(() => FontCatalogSchema.parse(catalog)).toThrow(/weight|range/i);
  });
});
