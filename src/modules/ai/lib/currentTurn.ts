/** Per-session turn tracking so file mutations can be correlated with the
 *  assistant message that produced them.
 *
 *  Lifecycle:
 *  1. beginTurn(sessionId) when a user message is sent
 *  2. tools call getActiveTurnId(sessionId) while recording mutations
 *  3. consumeFinishedTurn(sessionId) when the chat goes idle, then
 *     assignMessageId maps those mutations to the assistant message
 *
 *  If the next turn begins before the previous one is assigned (queue drain
 *  or a fast follow-up), beginTurn parks the previous active id in a finished
 *  queue so consumeFinishedTurn still returns the correct id. */

type SessionTurns = {
  active: string | null;
  finished: string[];
};

const bySession = new Map<string, SessionTurns>();

function slot(sessionId: string): SessionTurns {
  let s = bySession.get(sessionId);
  if (!s) {
    s = { active: null, finished: [] };
    bySession.set(sessionId, s);
  }
  return s;
}

function newTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a new turn for this session. Parks any unconsumed previous active
 *  turn so assign still sees it after a race with the next send. */
export function beginTurn(sessionId: string): string {
  const s = slot(sessionId);
  if (s.active) {
    s.finished.push(s.active);
  }
  const turnId = newTurnId();
  s.active = turnId;
  return turnId;
}

/** Turn id tools should stamp onto mutations for this session. */
export function getActiveTurnId(sessionId: string): string | null {
  return bySession.get(sessionId)?.active ?? null;
}

/** Take the oldest finished turn, or the current active turn if nothing is
 *  queued. Clears that id so a second consume does not re-assign it. */
export function consumeFinishedTurn(sessionId: string): string | null {
  const s = bySession.get(sessionId);
  if (!s) return null;
  if (s.finished.length > 0) {
    return s.finished.shift() ?? null;
  }
  if (s.active) {
    const id = s.active;
    s.active = null;
    return id;
  }
  return null;
}

/** Test helper: wipe all session turn state. */
export function __resetTurnsForTests(): void {
  bySession.clear();
}
