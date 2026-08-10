import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

export const hashValue = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export const hashFile = async (filePath: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
