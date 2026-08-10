import path from 'node:path';
import type {ColorOperation} from '../core/color';
import {resolveInside} from '../core/paths';
import {escapeFfmpegFilterValue} from './filter-escape';

const label = (value: string): string => `[${value}]`;

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

  segments.push(
    `[${outputInput}]zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited:` +
      'matrixin=gbr:transferin=bt709:primariesin=bt709[color_out]',
  );
  return {filterComplex: segments.join(';'), outputLabel: 'color_out'};
};

export const lutAbsolutePath = (projectPath: string, relativePath: string): string =>
  path.normalize(resolveInside(projectPath, relativePath));
