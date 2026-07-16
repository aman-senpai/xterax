import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell — which fires between commands — should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

/**
 * Used by the renderer pool on column resize: erase the live prompt before
 * (and after) xterm reflow so SIGWINCH redraw cannot stack a second Oh My
 * Zsh / p10k copy on top of reflowed cells.
 */
export type PromptResizeGuard = {
  /** True between commands (not in OSC 133 C..D), including while typing. */
  isIdle: () => boolean;
  /** Absolute buffer line of OSC 133 A, or null when busy / no marker yet. */
  idlePromptLine: () => number | null;
};

export function createPromptResizeGuard(
  prompt: PromptTracker,
  isFgRunning: () => boolean,
): PromptResizeGuard {
  return {
    isIdle: () => !isFgRunning(),
    idlePromptLine: () => {
      // Use fg-running (OSC 133 C..D), not inCommand: B is true while typing
      // at the prompt, and we still need to clear the typed line on resize.
      if (isFgRunning()) return null;
      const m = prompt.getMarker();
      if (!m || m.isDisposed) return null;
      return m.line;
    },
  };
}

/**
 * CSI to erase from the idle prompt through the end of the viewport.
 * Returns null when the prompt is scrolled out of view (leave history alone).
 */
export function promptClearSeq(
  markerLine: number,
  viewportY: number,
  rows: number,
): string | null {
  const row0 = markerLine - viewportY;
  if (row0 < 0 || row0 >= rows) return null;
  return `\x1b[${row0 + 1};1H\x1b[J`;
}

/**
 * CSI to erase the last `n` viewport rows (fallback when OSC 133 A is missing).
 * Multi-line p10k prompts are typically 2 rows; 4 covers path + gap + PS1.
 */
export function lastRowsClearSeq(rows: number, n: number): string | null {
  if (rows <= 0 || n <= 0) return null;
  const startRow0 = Math.max(0, rows - n);
  return `\x1b[${startRow0 + 1};1H\x1b[J`;
}

/** Local-only erase (not sent to the PTY). Invokes `then` after the write. */
export function clearIdlePromptRegion(
  term: Terminal,
  markerLine: number,
  then?: () => void,
): void {
  const buf = term.buffer.active;
  if (buf.type === "alternate") {
    then?.();
    return;
  }
  const seq = promptClearSeq(markerLine, buf.viewportY, term.rows);
  if (!seq) {
    then?.();
    return;
  }
  term.write(seq, then);
}

/** Local-only erase of the bottom `n` viewport rows. */
export function clearLastViewportRows(
  term: Terminal,
  n: number,
  then?: () => void,
): void {
  const buf = term.buffer.active;
  if (buf.type === "alternate") {
    then?.();
    return;
  }
  const seq = lastRowsClearSeq(term.rows, n);
  if (!seq) {
    then?.();
    return;
  }
  term.write(seq, then);
}

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  // Fires on C (process executing) and A/D (back at prompt). Distinct from
  // inCommand, which is already true from B while the user merely types.
  onCommandState?: (running: boolean) => void,
): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      onCommandState?.(false);
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
      onCommandState?.(true);
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
      onCommandState?.(false);
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}
