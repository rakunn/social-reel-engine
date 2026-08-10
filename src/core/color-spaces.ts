const canonicalColorSpaceToken = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const CANONICAL_REC709_TOKENS = new Set([
  'rec709',
  'rec709gamma24',
  'bt709',
  'bt709gamma24',
]);

export const isCanonicalRec709ColorSpace = (value: string): boolean =>
  CANONICAL_REC709_TOKENS.has(canonicalColorSpaceToken(value));
