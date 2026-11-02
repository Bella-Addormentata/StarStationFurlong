// 🖥️ The Star Station desktop app's own commands, as the game page sees them.
//
// Inside the desktop app (Tauri) the page can call the shell's commands
// through `window.__TAURI_INTERNALS__.invoke`, the private hook Tauri's own
// API package wraps. The page uses it directly, so it needs no npm package;
// the shell pins Tauri exactly, which keeps the hook stable. In a browser
// there is no such hook, and nothing here does anything.
//
// The one command the page calls is `open_backup`: the shell asks the node
// for the SSF wallet's 24 words over its own pipe and shows them in a window
// of its own. The page never receives the words. It sends no argument and
// reads back one of a fixed set of answers; anything else reads as
// `unavailable`. Nothing here can carry a word.

/** What `open_backup` answers: the backup window closed after the words
 *  were marked saved (`saved`) or without that (`closed`); the app has no
 *  channel to the node (`no_channel`, a node it did not start); the node
 *  runs on another network than the app (`other_network`); the wallet is
 *  not on, or is still turning on (`not_on`, `turning`); the words are
 *  marked saved already (`already_saved`); a window is open or just closed
 *  (`busy`). `unavailable`: anything else, a refused or failed call, an
 *  app without the command, or an answer this page does not know. */
export type NativeBackupAnswer =
  | 'saved'
  | 'closed'
  | 'no_channel'
  | 'other_network'
  | 'not_on'
  | 'turning'
  | 'already_saved'
  | 'busy'
  | 'unavailable';

/** The answers the shell may give, every one but `unavailable`. */
export const NATIVE_BACKUP_ANSWERS: readonly NativeBackupAnswer[] = Object.freeze([
  'saved',
  'closed',
  'no_channel',
  'other_network',
  'not_on',
  'turning',
  'already_saved',
  'busy',
]);

const KNOWN: ReadonlySet<string> = new Set(NATIVE_BACKUP_ANSWERS);

type Invoke = (cmd: string, args?: unknown) => unknown;

/** The shell's invoke hook, or null outside the desktop app (and in tests,
 *  where there is no window). */
function shellInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    const invoke = internals?.invoke;
    return typeof invoke === 'function' ? (invoke.bind(internals) as Invoke) : null;
  } catch {
    return null;
  }
}

/** Whether the page runs inside the desktop app, which can take commands.
 *  Also true under `tauri dev`, whose page is a loopback dev page. */
export function hasNativeShell(): boolean {
  return shellInvoke() !== null;
}

/** BACK UP in the desktop app: ask the shell to open its backup window, and
 *  wait for it to close. Never throws, never passes an argument, and gives
 *  back only one of the fixed answers. */
export async function openBackup(): Promise<NativeBackupAnswer> {
  const invoke = shellInvoke();
  if (!invoke) return 'unavailable';
  try {
    const answer: unknown = await invoke('open_backup');
    return typeof answer === 'string' && KNOWN.has(answer) ? (answer as NativeBackupAnswer) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
