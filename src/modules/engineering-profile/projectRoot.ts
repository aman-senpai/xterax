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
  if (!root) return anchoredRoot;

  const normNew = root.replace(/\/$/, '');
  if (!anchoredRoot) {
    anchoredRoot = root;
    return anchoredRoot;
  }

  const normAnchored = anchoredRoot.replace(/\/$/, '');

  // If the new root is not a subdirectory of (or equal to) the current anchored root,
  // it represents a different top-level project. Update the anchor so that
  // preferences are correctly scoped to the project the user is currently
  // working in (e.g. switching between terax-ai and resume checkouts in
  // different terminals or sessions).
  // This still protects against cd'ing into subdirectories of the current project
  // (a subdir root will be under the anchored one, so we keep the higher anchor
  // and write .terax/ at the stable project root, not the subdir).
  if (!normNew.startsWith(normAnchored + '/') && normNew !== normAnchored) {
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
