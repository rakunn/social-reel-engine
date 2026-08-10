export type StabilizedCrop = {zoom: number; x: number; y: number};

export const validateStabilizedCrop = (
  crop: StabilizedCrop,
): {valid: boolean; reason: string | null} => {
  if (crop.zoom < 1) {
    return {valid: false, reason: 'Stabilized crop would expose an image edge'};
  }
  if (crop.zoom > 1.5) {
    return {valid: false, reason: 'Stabilized crop requires excessive zoom'};
  }
  if (crop.x < 0 || crop.x > 1 || crop.y < 0 || crop.y > 1) {
    return {valid: false, reason: 'Stabilized crop center lies outside source bounds'};
  }
  return {valid: true, reason: null};
};

export const stabilizationOutcome = (
  detectionSucceeded: boolean,
  fallbackToUnstabilized: boolean,
): 'applied' | 'fallback' => {
  if (detectionSucceeded) return 'applied';
  if (fallbackToUnstabilized) return 'fallback';
  throw new Error('Stabilization failed and fallback is disabled');
};
