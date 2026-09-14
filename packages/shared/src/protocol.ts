import type { Quad } from './geometry.js';
import type { AskPayload, CellLabel, SayCategory, SessionSnapshot } from './session.js';

/** Messages the browser client sends over the WebSocket. */
export type ClientMessage =
  | { type: 'frame'; jpegBase64: string; capturedAt: number }
  | { type: 'answer'; askId: string; label: CellLabel }
  | { type: 'control'; action: 'new_game' };

/**
 * Per-frame board geometry in the source-frame pixel space the client
 * captures, so overlays drawn on the video line up with what the server saw.
 */
export interface FrameGeometry {
  width: number;
  height: number;
  /** Detected paper corners TL,TR,BR,BL; null when no paper is visible this frame. */
  paperQuad: Quad | null;
  /** Row-major cell polygons (index = engine cell 0–8), each TL,TR,BR,BL; null until a grid is detected. */
  cellQuads: Quad[] | null;
}

/** Messages the server pushes to the browser client. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'say'; category: SayCategory; text: string }
  | { type: 'ask'; ask: AskPayload }
  | { type: 'geometry'; geometry: FrameGeometry };
