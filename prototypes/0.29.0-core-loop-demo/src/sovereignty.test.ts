/**
 * 🛡 sovereignty — the convenience lanes are off unless the build says so,
 * and the test seam wins over the env.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convenienceLanesEnabled, setConvenienceLanesForTest, sourceKindAllowed } from './sovereignty';

afterEach(() => {
  vi.unstubAllEnvs();
  setConvenienceLanesForTest(null);
});

describe('the convenience lanes', () => {
  it('are off unless the build says VITE_SSF_CONVENIENCE_LANES=1, and only that', () => {
    expect(convenienceLanesEnabled()).toBe(false);
    expect(sourceKindAllowed('youtube')).toBe(false);
    expect(sourceKindAllowed('archive')).toBe(false);
    expect(sourceKindAllowed('url')).toBe(true); // serverless on the viewer's own origins (tvConsent)
    expect(sourceKindAllowed('file')).toBe(true);
    vi.stubEnv('VITE_SSF_CONVENIENCE_LANES', '1');
    expect(convenienceLanesEnabled()).toBe(true);
    expect(sourceKindAllowed('youtube')).toBe(true);
    expect(sourceKindAllowed('archive')).toBe(true);
    vi.stubEnv('VITE_SSF_CONVENIENCE_LANES', 'yes');
    expect(convenienceLanesEnabled()).toBe(false);
  });

  it('take the test seam over the env, and the env back when the seam is cleared', () => {
    vi.stubEnv('VITE_SSF_CONVENIENCE_LANES', '1');
    setConvenienceLanesForTest(false);
    expect(convenienceLanesEnabled()).toBe(false);
    setConvenienceLanesForTest(true);
    expect(convenienceLanesEnabled()).toBe(true);
    setConvenienceLanesForTest(null);
    expect(convenienceLanesEnabled()).toBe(true);
  });
});
