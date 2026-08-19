import path from 'node:path';
import type {ColorOperation} from '../core/color';
import {resolveInside} from '../core/paths';
import {escapeFfmpegFilterValue} from './filter-escape';

const label = (value: string): string => `[${value}]`;

export const REC709_OUTPUT_METADATA_ARGS = [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
] as const;

export const buildFfmpegColorGraph = (
  chain: {operations: ColorOperation[]},
  projectPath: string,
  inputLabel = '0:v',
): {filterComplex: string; outputLabel: 'color_out'} => {
  const operations = chain.operations;
  const pre = operations.find((operation) => operation.type === 'pre-transform');
  const normalizer = operations.find(
    (operation) => operation.type === 'technical-lut' || operation.type === 'combined-lut',
  );
  const creative = operations.find((operation) => operation.type === 'creative-lut');
  const landHaze = operations.find((operation) => operation.type === 'land-haze');
  if (!pre || !normalizer) {
    throw new Error('FFmpeg color graph requires pre-transform and normalization operations');
  }

  const exposure = Number(pre.exposureStops.toFixed(4));
  const tint = Number((-pre.tint).toFixed(4));
  const normalizerPath = escapeFfmpegFilterValue(resolveInside(projectPath, normalizer.lut.file));
  const segments = [
    `${label(inputLabel)}format=gbrp16le,exposure=exposure=${exposure}:black=0,` +
      `colortemperature=temperature=${pre.whiteBalanceKelvin}:pl=1,` +
      `colorbalance=gm=${tint}[pre_color]`,
    `[pre_color]lut3d=file=${normalizerPath}[normalized]`,
  ];

  let outputInput = 'normalized';
  if (creative) {
    const creativePath = escapeFfmpegFilterValue(resolveInside(projectPath, creative.lut.file));
    const mix = Number(creative.mix.toFixed(4));
    segments.push('[normalized]split=2[creative_base][creative_input]');
    segments.push(`[creative_input]lut3d=file=${creativePath}[creative_look]`);
    segments.push(
      `[creative_base][creative_look]blend=all_expr='A*(1-${mix})+B*${mix}'[creative_blend]`,
    );
    outputInput = 'creative_blend';
  }

  if (landHaze?.type === 'land-haze') {
    const strength = Number(landHaze.strength.toFixed(4));
    const contrast = Number((1 + strength * 0.1).toFixed(4));
    const brightness = Number((-strength * 0.01).toFixed(4));
    const saturation = Number((1 - strength * 0.02).toFixed(4));
    const maskExpression =
      'if(gt(g(X,Y),b(X,Y)+18)+gt(r(X,Y),b(X,Y)+10)*gt(g(X,Y),b(X,Y)+4),200,0)';
    segments.push(
      `[${outputInput}]format=gbrp16le,split=3[land_base][land_look][land_mask_base]`,
    );
    segments.push(
      `[land_look]eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}[land_looked]`,
    );
    segments.push(
      `[land_mask_base]format=rgb24,` +
        `geq=r='${maskExpression}':g='${maskExpression}':b='${maskExpression}',` +
        'format=gray,boxblur=8:2[land_mask]',
    );
    segments.push(
      '[land_base][land_looked][land_mask]maskedmerge,format=gbrp16le[land_treated]',
    );
    outputInput = 'land_treated';
  }

  segments.push(
    `[${outputInput}]zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited:` +
      'matrixin=gbr:transferin=bt709:primariesin=bt709[color_out]',
  );
  return {filterComplex: segments.join(';'), outputLabel: 'color_out'};
};

export const lutAbsolutePath = (projectPath: string, relativePath: string): string =>
  path.normalize(resolveInside(projectPath, relativePath));
