import path from 'node:path';
import {
  LutDefinitionSchema,
  LutDefinitionsSchema,
  type LutDefinition,
} from '../contracts/schemas';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {ingestFilesWithinStatusScanLock} from './ingest';
import {runWithStatusScanLock} from './operation';

type CatalogEntry = Omit<LutDefinition, 'file'> & {file: string};
type LutCatalog = {
  schemaVersion: '1.0.0';
  technical: CatalogEntry[];
  creative: CatalogEntry[];
  unclassified: Array<{id: string; file: string; blocked: true; reason: string}>;
};

export const readLutCatalog = async (engineRoot: string): Promise<LutCatalog> =>
  await readJson<LutCatalog>(path.join(engineRoot, 'library/lut-catalog.json'));

export const installCatalogLut = async (
  projectPath: string,
  engineRoot: string,
  id: string,
): Promise<LutDefinition> => {
  const result = await runWithStatusScanLock(projectPath, async () => {
    const catalog = await readLutCatalog(engineRoot);
    const blocked = catalog.unclassified.find((entry) => entry.id === id);
    if (blocked) {
      throw new Error(`${id} is blocked: ${blocked.reason}`);
    }
    const entry = [...catalog.technical, ...catalog.creative].find(
      (candidate) => candidate.id === id,
    );
    if (!entry) {
      throw new Error(`Unknown catalog LUT "${id}"`);
    }
    const sourcePath = path.join(engineRoot, entry.file);
    if ((await hashFile(sourcePath)) !== entry.checksumSha256) {
      throw new Error(`Catalog LUT checksum mismatch: ${entry.file}`);
    }
    const kind = entry.kind === 'creative' ? 'creative-lut' : 'technical-lut';
    await ingestFilesWithinStatusScanLock(projectPath, [sourcePath], kind);
    const projectFile =
      entry.kind === 'creative'
        ? `input/luts/creative/${path.basename(sourcePath)}`
        : `input/luts/technical/${path.basename(sourcePath)}`;
    const definition = LutDefinitionSchema.parse({...entry, file: projectFile});
    const configPath = path.join(projectPath, 'config/luts.json');
    const config = await readJson<{schemaVersion: '1.0.0'; luts: unknown[]}>(configPath);
    const existing = LutDefinitionsSchema.parse(config.luts);
    const sameId = existing.find((lut) => lut.id === definition.id);
    if (sameId && JSON.stringify(sameId) !== JSON.stringify(definition)) {
      throw new Error(`Project already contains conflicting metadata for LUT ${definition.id}`);
    }
    if (!sameId) {
      existing.push(definition);
      existing.sort((left, right) => left.id.localeCompare(right.id));
      await writeJson(configPath, {schemaVersion: '1.0.0', luts: existing});
    }
    return definition;
  });
  if (!result.acquired) {
    throw new Error(
      'Cannot install a catalog LUT while a project snapshot, status scan, or media work is active',
    );
  }
  return result.value;
};
