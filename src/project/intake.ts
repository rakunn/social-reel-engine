import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {EditManifestSchema, LutDefinitionsSchema, LutDefinitionSchema, ReelBriefSchema, SourceEntrySchema, type LutDefinition} from '../contracts/schemas';
import {readJson} from '../core/json';
import {hashFile} from '../core/hash';
import {resolveInside} from '../core/paths';
import {lutCompatibilityFailures} from '../core/lut-compatibility';
import {cameraFromConfirmation, sourceIdFor} from '../media/analyze';
import {readRightsConfirmationStatus, currentRightsAssets} from '../edit/rights';
import {validateEdit} from '../edit/validate';
import {createSourceIntegrityContext, readVerifiedInputSnapshot, type SourceIntegrityContext} from '../media/source-integrity';
import {scanInputs, type IngestManifest} from './ingest';
import {readLutCatalog} from './library';

export type IntakeRequirement = {
  code: 'clips' | 'source-profile' | 'normalization-lut' | 'lut-metadata' | 'lut-file' | 'lut-selection' | 'edit' | 'configuration' | 'rights-confirmation';
  action: 'ask-user' | 'configure';
  blocks: 'analysis' | 'preview' | 'grading' | 'export';
  paths: string[];
  message: string;
};

export type ProjectIntake = {
  scope: 'supplied' | 'selected';
  requirements: IntakeRequirement[];
  rights: {
    status: 'confirmed' | 'unconfirmed' | 'indeterminate';
    reason: string | null;
    confirmed: boolean;
    requiresExplicitConfirmation: boolean;
    assets: Array<{relativePath: string; checksumSha256: string}>;
    assetScope: 'supplied' | 'used';
  };
};

const SourcesConfigSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  sources: z.record(z.string(), z.object({
    manufacturer: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    gamma: z.string().nullable().optional(),
    gamut: z.string().nullable().optional(),
    profileId: z.string().nullable().optional(),
    confirmed: z.boolean().optional(),
  })),
});

const defaultEngineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Called inside status's snapshot lock, never while a media operation is active.
// This is an intake inventory, not permission to bypass grading/export checks.
export const readProjectIntake = async (
  projectPath: string,
  options: {engineRoot?: string; ingest?: IngestManifest; integrity?: SourceIntegrityContext} = {},
): Promise<ProjectIntake> => {
  const ingest = options.ingest ?? await scanInputs(projectPath);
  const requirements: IntakeRequirement[] = [];
  const add = (requirement: IntakeRequirement) => requirements.push(requirement);
  const integrity = options.integrity ?? createSourceIntegrityContext();
  let edit = await readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema).catch(() => null);
  if (edit) {
    try {
      await readVerifiedInputSnapshot(projectPath, integrity, ingest);
      if (!(await validateEdit(projectPath, edit, {integrity})).valid) edit = null;
    } catch {
      edit = null;
    }
  }
  if (!edit) add({code: 'edit', action: 'configure', blocks: 'preview', paths: ['edits/edit.json'],
    message: 'Author and validate the edit from analyzed source IDs; choose creative defaults from the brief.'});

  let confirmations: z.infer<typeof SourcesConfigSchema>['sources'] = {};
  try {
    confirmations = (await readJson(path.join(projectPath, 'config/sources.json'), SourcesConfigSchema)).sources;
  } catch {
    add({code: 'configuration', action: 'configure', blocks: 'analysis', paths: ['config/sources.json'],
      message: 'Repair the source configuration using verified facts; ask for any unresolved camera/profile information.'});
  }
  let luts: LutDefinition[] = [];
  try {
    const config = await readJson<{luts: unknown}>(path.join(projectPath, 'config/luts.json'));
    luts = LutDefinitionsSchema.parse(config.luts);
  } catch {
    add({code: 'lut-metadata', action: 'configure', blocks: 'grading', paths: ['config/luts.json'],
      message: 'Record valid LUT declarations with checksums and verified input/output spaces and transform semantics. Ask the user for facts that are unavailable.'});
  }

  const files = new Map(ingest.files.map((file) => [file.relativePath, file]));
  const selectedLutIds = edit ? new Set(edit.clips.flatMap(({grade}) =>
    [grade.technicalLutId, grade.combinedLutId, grade.creativeLutId].filter((id): id is string => Boolean(id)))) : null;
  for (const id of selectedLutIds ?? []) {
    if (!luts.some((lut) => lut.id === id)) add({
      code: 'lut-metadata', action: 'configure', blocks: 'grading', paths: ['config/luts.json', 'edits/edit.json'],
      message: `The selected LUT ${id} has no valid declaration. Match it to a supplied file and record verified metadata; ask for the file or transform facts only if missing.`,
    });
  }
  const usableLuts: LutDefinition[] = [];
  for (const lut of luts) {
    const file = files.get(lut.file);
    if (file?.checksumSha256 === lut.checksumSha256) {
      usableLuts.push(lut);
    } else if (!selectedLutIds || selectedLutIds.has(lut.id)) {
      add({code: 'lut-file', action: 'ask-user', blocks: 'grading', paths: [lut.file],
        message: `Supply the declared LUT ${lut.id}; its project file is missing or its checksum changed. Ingest a verified copy and revalidate its declaration.`});
    }
  }
  const undeclared = ingest.files.filter((file) =>
    (file.kind === 'technical-lut' || file.kind === 'creative-lut') && !luts.some((lut) => lut.file === file.relativePath));
  if (!edit && undeclared.length) add({code: 'lut-metadata', action: 'configure', blocks: 'grading',
    paths: undeclared.map((file) => file.relativePath),
    message: 'LUT files are already supplied. Record their checksums and verified transform metadata in config/luts.json; ask only for missing semantics, not the files again.'});

  const suppliedClips = ingest.files.filter((file) => file.kind === 'clips');
  const clips = edit ? suppliedClips.filter((file) => edit.clips.some((clip) =>
    clip.sourceId === sourceIdFor('video', file.relativePath, file.checksumSha256))) : suppliedClips;
  if (!suppliedClips.length) add({code: 'clips', action: 'ask-user', blocks: 'analysis', paths: ['input/clips'],
    message: 'Ask the user to supply footage paths, then copy the originals with ingest --kind clips.'});
  if (edit && edit.clips.some((clip) => !clips.some((file) =>
    clip.sourceId === sourceIdFor('video', file.relativePath, file.checksumSha256)))) {
    add({code: 'edit', action: 'configure', blocks: 'preview', paths: ['edits/edit.json'],
      message: 'The edit references missing or changed source IDs. Restore the intended inputs or rerun analyze and update the edit.'});
  }

  let catalogLuts: LutDefinition[] | undefined;
  const availableCatalogLuts = async () => {
    if (catalogLuts) return catalogLuts;
    catalogLuts = [];
    const engineRoot = options.engineRoot ?? defaultEngineRoot;
    try {
      const catalog = await readLutCatalog(engineRoot);
      for (const entry of catalog.technical) {
        const parsed = LutDefinitionSchema.safeParse(entry);
        if (!parsed.success) continue;
        try {
          if (await hashFile(resolveInside(engineRoot, parsed.data.file)) === parsed.data.checksumSha256) {
            catalogLuts.push(parsed.data);
          }
        } catch { /* An optional catalog entry is not an installed asset. */ }
      }
    } catch { /* User-supplied project LUTs do not require a local catalog. */ }
    return catalogLuts;
  };

  for (const file of clips) {
    const source = SourceEntrySchema.safeParse({
      id: sourceIdFor('video', file.relativePath, file.checksumSha256),
      relativePath: file.relativePath, checksumSha256: file.checksumSha256, sizeBytes: file.sizeBytes,
      mediaType: 'video', ffprobe: {streams: []}, camera: cameraFromConfirmation(confirmations[file.relativePath]),
    });
    if (!source.success || !source.data.camera.confirmed) {
      add({code: 'source-profile', action: 'ask-user', blocks: 'grading', paths: [file.relativePath],
        message: 'Confirm the camera model and exact recording gamma/gamut. Record these facts and the matching profile ID in config/sources.json; never guess from appearance or filenames.'});
      // Request the missing file in the same intake as profile facts, when knowable.
      if (!usableLuts.some((lut) => lut.kind !== 'creative') &&
          !ingest.files.some((asset) => asset.kind === 'technical-lut') &&
          (await availableCatalogLuts()).length === 0) {
        add({code: 'normalization-lut', action: 'ask-user', blocks: 'grading', paths: [file.relativePath],
          message: 'Supply the technical or combined normalization LUT for this recording profile if no verified matching local transform is available. Creative LUTs are optional.'});
      }
      continue;
    }
    const compatible = usableLuts.filter((lut) => lutCompatibilityFailures(source.data, lut).length === 0);
    const selections = edit?.clips.filter((clip) => clip.sourceId === source.data.id) ?? [];
    const selectionReady = selections.length > 0 && selections.every((clip) =>
      compatible.some((lut) => lut.id === (clip.grade.combinedLutId ?? clip.grade.technicalLutId)));
    if (selectionReady) continue;
    if (compatible.length) {
      add({code: 'lut-selection', action: 'configure', blocks: 'grading', paths: [file.relativePath, 'edits/edit.json'],
        message: `Use a verified compatible normalization transform in the edit: ${compatible.map((lut) => lut.id).join(', ')}.`});
      continue;
    }
    const available = (await availableCatalogLuts()).filter((lut) => lutCompatibilityFailures(source.data, lut).length === 0);
    if (available.length) {
      add({code: 'lut-selection', action: 'configure', blocks: 'grading', paths: [file.relativePath],
        message: `A compatible local LUT is available. Ingest it with --library ${available.map((lut) => lut.id).join(' or ')} and select it in the edit.`});
    } else if (undeclared.some((asset) => asset.kind === 'technical-lut')) {
      add({code: 'lut-metadata', action: 'configure', blocks: 'grading', paths: undeclared.map((asset) => asset.relativePath),
        message: 'Check the supplied technical LUT metadata against this confirmed profile. Ask for missing semantics; request another LUT only if the supplied one is incompatible.'});
    } else {
      add({code: 'normalization-lut', action: 'ask-user', blocks: 'grading', paths: [file.relativePath],
        message: `Supply a technical or combined LUT for ${source.data.camera.model}, ${source.data.camera.gamma}/${source.data.camera.gamut} → Rec.709. Ingest with --kind technical-lut and record verified metadata in config/luts.json. A creative LUT is optional.`});
    }
  }

  const rightsErrors: string[] = [];
  const recordRightsError = (error: unknown) => {
    rightsErrors.push(error instanceof Error ? error.message : String(error));
    return null;
  };
  const brief = await readJson(path.join(projectPath, 'brief.json'), ReelBriefSchema).catch(recordRightsError);
  const rightsStatus = edit ? await readRightsConfirmationStatus(projectPath, {integrity}).catch(recordRightsError) : null;
  const usedAssets = edit ? await currentRightsAssets(projectPath, {integrity}).catch(recordRightsError) : null;
  const unresolvedAssets = requirements.filter((requirement) =>
    ['source-profile', 'normalization-lut', 'lut-metadata', 'lut-file', 'lut-selection', 'configuration'].includes(requirement.code));
  const indeterminate = unresolvedAssets.length > 0 || rightsErrors.length > 0 || !brief || !edit || !rightsStatus || !usedAssets?.length;
  const rightsConfirmed = !indeterminate && rightsStatus?.confirmed === true;
  const reason = indeterminate
    ? rightsErrors.length ? [...new Set(rightsErrors)].join('; ')
      : unresolvedAssets.length ? `Resolve asset-affecting intake requirements before requesting rights confirmation: ${[...new Set(unresolvedAssets.map((requirement) => requirement.code))].join(', ')}`
        : 'A valid edit and a nonempty resolved used-asset set are required before requesting rights confirmation'
    : rightsStatus?.reason ?? (rightsConfirmed ? null : 'Usage rights require explicit user confirmation');
  if (rightsErrors.length || indeterminate) add({
    code: 'configuration', action: 'configure', blocks: 'export',
    paths: !brief ? ['brief.json'] : !edit ? ['edits/edit.json'] : ['config/luts.json', 'config/style.json', 'analysis/sources.json'],
    message: `Rights verification is blocked: ${rightsErrors.length ? [...new Set(rightsErrors)].join('; ') : reason}. Repair the reported configuration or inputs, then rerun status. Retain any recorded rights confirmation until the current asset fingerprint can be checked.`,
  });
  const rights: ProjectIntake['rights'] = {
    status: indeterminate ? 'indeterminate' : rightsConfirmed ? 'confirmed' : 'unconfirmed',
    reason,
    confirmed: rightsConfirmed,
    requiresExplicitConfirmation: !indeterminate && !rightsConfirmed,
    assets: usedAssets ?? ingest.files.map(({relativePath, checksumSha256}) => ({relativePath, checksumSha256})),
    assetScope: usedAssets ? 'used' : 'supplied',
  };
  if (rights.requiresExplicitConfirmation) add({code: 'rights-confirmation', action: 'ask-user', blocks: 'export',
    paths: rights.assets.map((asset) => asset.relativePath),
    message: `${rightsStatus?.reason ?? 'Usage rights require explicit user confirmation'}. Present the asset inventory and ask the user to explicitly confirm permission for all used assets. Run confirm-rights only after their response covers the current used set; supplying files or a license label is not confirmation.`});
  return {scope: edit ? 'selected' : 'supplied', requirements, rights};
};
