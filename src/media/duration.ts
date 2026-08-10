const parseRational = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? 1);
  if (
    denominator === 0 ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator)
  ) {
    return null;
  }
  return numerator / denominator;
};

export const streamDurationSeconds = (
  stream: Record<string, unknown>,
): number | null => {
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  const durationTs = Number(stream.duration_ts);
  const timeBase = parseRational(stream.time_base);
  const derived = durationTs * (timeBase ?? Number.NaN);
  return Number.isFinite(derived) && derived > 0 ? derived : null;
};
