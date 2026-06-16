/**
 * Stable project-root anchor for the engineering profile system.
 *
 * The terminal's cwd changes with every `cd`, but the engineering profile
 * should be anchored to the directory Terax was opened in (the user's
 * actual project), not the current terminal location. Without this,
 * navigating into a subdirectory would relocate the .terx/ directory.
 *
 * `anchorProjectRoot` latches the first non-null workspace root it sees
 * and never changes for the lifetime of the app. Call it from the
 * transport `sendMessages` to bootstrap once per (app, project) pair.
 */

let anchoredRoot: string | null = null;

export function anchorProjectRoot(root: string | null): string | null {
  if (anchoredRoot) return anchoredRoot;
  if (root) {
    anchoredRoot = root;
  }
  return anchoredRoot;
}

export function getAnchoredProjectRoot(): string | null {
  return anchoredRoot;
}

export function resetAnchoredProjectRoot(): void {
  anchoredRoot = null;
}
