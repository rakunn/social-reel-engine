import {
  GradeTreatmentSchema,
  LutDefinitionSchema,
  type LutDefinition,
} from '../contracts/schemas';

export type ColorOperation =
  | {
      type: 'pre-transform';
      exposureStops: number;
      whiteBalanceKelvin: number;
      tint: number;
    }
  | {type: 'technical-lut'; lut: LutDefinition; mix: 1}
  | {type: 'creative-lut'; lut: LutDefinition; mix: number}
  | {type: 'combined-lut'; lut: LutDefinition; mix: 1}
  | {type: 'land-haze'; strength: number}
  | {type: 'rec709-output'; primaries: 'bt709'; transfer: 'bt709'; matrix: 'bt709'};

export type ColorChainInput = {
  exposureStops: number;
  whiteBalanceKelvin: number;
  tint: number;
  technical?: unknown;
  creative?: unknown;
  combined?: unknown;
  creativeMix?: number;
  treatment?: unknown;
};

export const buildColorChain = (
  input: ColorChainInput,
): {operations: ColorOperation[]} => {
  const technical = input.technical ? LutDefinitionSchema.parse(input.technical) : null;
  const creative = input.creative ? LutDefinitionSchema.parse(input.creative) : null;
  const combined = input.combined ? LutDefinitionSchema.parse(input.combined) : null;
  const treatment = input.treatment ? GradeTreatmentSchema.parse(input.treatment) : null;

  if (technical && technical.kind !== 'technical') {
    throw new Error('technical must refer to a technical LUT');
  }
  if (creative && creative.kind !== 'creative') {
    throw new Error('creative must refer to a creative LUT');
  }
  if (combined && combined.kind !== 'combined') {
    throw new Error('combined must refer to a combined LUT');
  }
  if (technical && combined) {
    throw new Error('A combined LUT must replace, not stack with, the technical LUT');
  }
  if (!technical && !combined) {
    throw new Error('Color chain requires a confirmed technical or combined transform');
  }
  if (combined && creative) {
    throw new Error('A combined technical/creative LUT already includes the look and cannot stack a creative LUT');
  }

  const operations: ColorOperation[] = [
    {
      type: 'pre-transform',
      exposureStops: input.exposureStops,
      whiteBalanceKelvin: input.whiteBalanceKelvin,
      tint: input.tint,
    },
  ];

  if (combined) {
    operations.push({type: 'combined-lut', lut: combined, mix: 1});
  } else if (technical) {
    operations.push({type: 'technical-lut', lut: technical, mix: 1});
    if (creative) {
      const mix = input.creativeMix ?? creative.defaultMix;
      if (mix < 0 || mix > 1) {
        throw new Error('Creative LUT mix must be between 0 and 1');
      }
      operations.push({type: 'creative-lut', lut: creative, mix});
    }
  }

  if (treatment) {
    operations.push({type: treatment.kind, strength: treatment.strength});
  }

  operations.push({
    type: 'rec709-output',
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
  });
  return {operations};
};
