import type { AskPayload, CellLabel, SayCategory, SessionSnapshot } from './session.js';

/** Messages the browser client sends over the WebSocket. */
export type ClientMessage =
  | { type: 'frame'; jpegBase64: string; capturedAt: number }
  | { type: 'answer'; askId: string; label: CellLabel }
  | { type: 'control'; action: 'new_game' };

/** Messages the server pushes to the browser client. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'say'; category: SayCategory; text: string }
  | { type: 'ask'; ask: AskPayload };
