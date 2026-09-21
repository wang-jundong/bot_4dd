const originWallMs = Date.now();
const originMonoMs = performance.now();

export const monotonicMs = (): number => performance.now();
export const estimatedWallMs = (monoMs = monotonicMs()): number => originWallMs + monoMs - originMonoMs;
