/**
 * Exponential moving average — blends each new sample into a running state
 * to dampen jitter. Lower alpha is smoother but laggier; 0.3 is a reasonable
 * default for noisy metrics like CPU usage
 *
 * The first sample seeds the state directly so readings don't ramp up from 0
 */
export function createEma(alpha: number) {
  let state = 0;
  let initialized = false;
  return (sample: number): number => {
    if (!initialized) {
      state = sample;
      initialized = true;
    } else {
      state += alpha * (sample - state);
    }
    return state;
  };
}
