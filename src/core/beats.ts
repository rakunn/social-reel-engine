export const snapToNearestBeat = (
  timestamp: number,
  beats: readonly number[],
  maximumDistance: number,
): number => {
  if (beats.length === 0) {
    return timestamp;
  }
  const nearest = beats.reduce((best, beat) =>
    Math.abs(beat - timestamp) < Math.abs(best - timestamp) ? beat : best,
  );
  return Math.abs(nearest - timestamp) <= maximumDistance ? nearest : timestamp;
};
