/**
 * 🛡 sovereignty — which lanes THIS BUILD offers.
 *
 * The owner's ruling of 2026-10-04: the serverless sources only, with the
 * centralized lanes (YouTube, archive.org, a link on a third-party server,
 * the EmulatorJS CDN) kept in the code for later. A build that wants them
 * back sets VITE_SSF_CONVENIENCE_LANES=1; nothing else turns them on, and a
 * peer's record cannot — the readers below are this page's own, so a
 * record naming a lane this build does not offer plays nothing here and the
 * screen says why.
 *
 * The env read is written out LITERALLY, the treasuryNetwork rule: Vite
 * substitutes `import.meta.env.VITE_FOO` by matching that exact text, and a
 * computed lookup would survive into the bundle unsubstituted. process.env
 * is the fallback for node tooling and tests; the seam below overrides
 * both, for tests that need either posture.
 */

let override: boolean | null = null;

/** Tests: force the convenience lanes on or off; null returns to the env. */
export function setConvenienceLanesForTest(on: boolean | null): void {
  override = on;
}

/** Whether this build offers the centralized lanes at all. Off by default. */
export function convenienceLanesEnabled(): boolean {
  if (override !== null) return override;
  let fromMeta: string | undefined;
  try {
    fromMeta = import.meta.env.VITE_SSF_CONVENIENCE_LANES;
  } catch {
    /* import.meta.env is absent outside Vite */
  }
  if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) return fromMeta.trim() === '1';
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return (proc?.env?.VITE_SSF_CONVENIENCE_LANES ?? '').trim() === '1';
  } catch {
    return false;
  }
}

/** The TV source kinds that are a centralized service: offered, parsed and
 *  played only with the lanes on. Everything else — a URL on the viewer's
 *  own origins, and the file, torrent and karaoke lanes to come — is
 *  serverless and always on. */
export function sourceKindAllowed(kind: string): boolean {
  return (kind !== 'youtube' && kind !== 'archive') || convenienceLanesEnabled();
}

/** What the screen says when a lane is off: one phrase, everywhere. */
export const SERVERLESS_ONLY = 'this build plays serverless sources only';
