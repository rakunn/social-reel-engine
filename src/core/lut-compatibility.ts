import type {LutDefinition, SourceEntry} from '../contracts/schemas';
import {isCanonicalRec709ColorSpace} from './color-spaces';

const normalizeIdentity = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replaceAll(/[^a-z0-9]/g, '');

export const lutCompatibilityFailures = (
  source: SourceEntry,
  lut: LutDefinition,
): string[] => {
  const failures: string[] = [];
  if (lut.kind !== 'technical' && lut.kind !== 'combined') {
    return [`LUT ${lut.id} is ${lut.kind}, not a normalization transform`];
  }
  if (!source.camera.confirmed || !source.camera.profileId) {
    return [`${source.relativePath}: camera gamma/gamut profile is unconfirmed`];
  }
  if (lut.profileId !== source.camera.profileId) {
    failures.push(
      `${source.relativePath}: LUT profile ${lut.profileId ?? 'unset'} does not match confirmed source profile ${source.camera.profileId}`,
    );
  }
  if (
    lut.cameraModel &&
    normalizeIdentity(lut.cameraModel) !== normalizeIdentity(source.camera.model ?? '')
  ) {
    failures.push(
      `${source.relativePath}: LUT camera ${lut.cameraModel} does not match confirmed source model ${source.camera.model}`,
    );
  }
  if (
    !lut.inputGamma ||
    normalizeIdentity(lut.inputGamma) !== normalizeIdentity(source.camera.gamma ?? '')
  ) {
    failures.push(
      `${source.relativePath}: LUT input gamma ${lut.inputGamma ?? 'unset'} does not match confirmed source gamma ${source.camera.gamma}`,
    );
  }
  if (
    !lut.inputGamut ||
    normalizeIdentity(lut.inputGamut) !== normalizeIdentity(source.camera.gamut ?? '')
  ) {
    failures.push(
      `${source.relativePath}: LUT input gamut ${lut.inputGamut ?? 'unset'} does not match confirmed source gamut ${source.camera.gamut}`,
    );
  }
  if (!isCanonicalRec709ColorSpace(lut.outputColorSpace)) {
    failures.push(`${source.relativePath}: normalization LUT output must be declared as Rec.709`);
  }
  return failures;
};

export const assertLutCompatibleWithSource = (
  source: SourceEntry,
  lut: LutDefinition,
): void => {
  const failures = lutCompatibilityFailures(source, lut);
  if (failures.length) throw new Error(failures.join('; '));
};
