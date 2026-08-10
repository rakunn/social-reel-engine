const escapeOnce = (value: string): string =>
  value.replace(/[\\':,;\[\]=\s]/g, '\\$&');

export const escapeFfmpegFilterValue = (value: string): string =>
  escapeOnce(escapeOnce(value));
