import {
  applyMove,
  bestMove,
  cellName,
  emptyBoard,
  isConsistent,
  isFull,
  isTerminal,
  other,
  whoseTurn,
  winner,
  type Board,
  type Player,
} from '@vistactoe/engine';
import {
  mergeConfig,
  type AppConfig,
  type AskPayload,
  type CellLabel,
  type CellReading,
  type DeepPartial,
  type Effect,
  type GameResult,
  type Observation,
  type Phase,
  type SayCategory,
  type SessionSnapshot,
} from '@vistactoe/shared';
import { resolveBoard, type Resolution } from './resolver.js';

interface ActiveGame {
  board: Board;
  toMove: Player;
  pendingAgentCell: number | null;
  history: { player: Player; cell: number }[];
  result: GameResult | null;
}

const symbolPhrase = (s: Player): string => (s === 'X' ? 'an X' : 'an O');

/**
 * The session state machine. Owns game state and turn logic; consumes stable
 * perception observations and human answers, and returns effects (speech,
 * questions, log events) for the host to perform. Deliberately free of I/O,
 * timers and camera concerns so the whole flow is unit-testable.
 */
export class GameSession {
  private readonly config: AppConfig;
  private phase: Phase = 'no_paper';
  private game: ActiveGame | null = null;
  private gameNumber = 0;

  private pendingAsk: AskPayload | null = null;
  private pendingObservation: CellReading[] | null = null;
  private resumePhase: 'human_turn' | 'awaiting_agent_mark' = 'human_turn';
  private askSeq = 0;
  private lastReminder: string | null = null;
  /** Which page-lost prompt is currently showing, so we neither spam nor swallow it. */
  private pagePrompt: 'no_paper' | 'no_grid' | null = null;

  constructor(config?: DeepPartial<AppConfig>) {
    this.config = mergeConfig(config);
  }

  get humanSymbol(): Player {
    return this.config.humanSymbol;
  }

  get agentSymbol(): Player {
    return other(this.config.humanSymbol);
  }

  onObservation(obs: Observation): Effect[] {
    const effects: Effect[] = [];
    switch (obs.kind) {
      case 'unstable':
        break;
      case 'no_paper':
        this.enterPageLost(effects, 'no_paper', "I can't see the page — please show me the paper.");
        break;
      case 'no_grid':
        this.enterPageLost(effects, 'no_grid', 'I see the page but no board — please draw a 3×3 grid on it.');
        break;
      case 'board':
        this.handleBoard(effects, obs.cells);
        break;
    }
    return effects;
  }

  onAnswer(askId: string, label: CellLabel, source: 'human' | 'vlm' = 'human'): Effect[] {
    const effects: Effect[] = [];
    if (this.phase !== 'awaiting_answer' || this.pendingAsk?.id !== askId || !this.pendingObservation) {
      return effects; // stale or unexpected answer
    }
    const cell = this.pendingAsk.cell;
    this.log(effects, 'answer', { askId, cell, label, source });
    this.resumeWithReading(effects, cell, { label, confidence: 1 });
    return effects;
  }

  onControl(action: 'new_game'): Effect[] {
    const effects: Effect[] = [];
    if (action === 'new_game') {
      this.game = null;
      this.clearAsk();
      this.phase = 'game_over';
      this.say(effects, 'prompt', "Okay — show me a fresh 3×3 grid when you're ready.");
      this.log(effects, 'control', { action });
    }
    return effects;
  }

  snapshot(): SessionSnapshot {
    return {
      phase: this.phase,
      board: this.game ? [...this.game.board] : emptyBoard(),
      humanSymbol: this.humanSymbol,
      agentSymbol: this.agentSymbol,
      toMove: this.game && !this.game.result ? this.game.toMove : null,
      pendingAgentCell: this.game?.pendingAgentCell ?? null,
      pendingAsk: this.pendingAsk,
      result: this.game?.result ?? null,
      gameNumber: this.gameNumber,
      moveHistory: this.game ? [...this.game.history] : [],
    };
  }

  // ---- observation handling ------------------------------------------------

  private enterPageLost(effects: Effect[], phase: 'no_paper' | 'no_grid', prompt: string): void {
    if (this.pagePrompt === phase) return;
    this.pagePrompt = phase;
    // A pending question about a page we can no longer see is meaningless.
    this.clearAsk();
    this.phase = phase;
    this.lastReminder = null;
    this.say(effects, 'prompt', prompt);
    this.log(effects, 'page_lost', { phase });
  }

  private handleBoard(effects: Effect[], cells: CellReading[]): void {
    this.pagePrompt = null; // the board is visible again
    if (this.phase === 'awaiting_answer') {
      this.handleBoardWhileAsking(effects, cells);
      return;
    }

    if (this.phase === 'game_over' || this.phase === 'corrupted') {
      if (cells.every((c) => c.label === 'empty')) {
        this.startGame(effects);
      }
      return; // the finished/corrupt page is still in view — nothing to do
    }

    if (!this.game) {
      if (cells.every((c) => c.label === 'empty')) {
        this.startGame(effects);
      } else {
        this.adoptBoard(effects, cells);
      }
      return;
    }

    if (this.phase === 'no_paper' || this.phase === 'no_grid') {
      // Re-locked mid-game: restore the play phase, then let normal resolution
      // absorb anything that was drawn while the page was out of sight.
      this.phase = this.game.pendingAgentCell !== null ? 'awaiting_agent_mark' : 'human_turn';
      this.log(effects, 'relock', { phase: this.phase });
    }

    if (this.phase !== 'human_turn' && this.phase !== 'awaiting_agent_mark') return;

    const resolution = resolveBoard({
      observed: cells,
      committed: this.game.board,
      phase: this.phase,
      humanSymbol: this.humanSymbol,
      agentSymbol: this.agentSymbol,
      pendingAgentCell: this.game.pendingAgentCell,
      askThreshold: this.config.confidence.ask,
    });
    this.applyResolution(effects, resolution, cells);
  }

  private handleBoardWhileAsking(effects: Effect[], cells: CellReading[]): void {
    const ask = this.pendingAsk;
    if (!ask) return;
    const reading = cells[ask.cell];
    if (reading && reading.confidence >= this.config.confidence.ask) {
      // The mark became legible on its own (ink darkened, hand moved away).
      this.log(effects, 'answer', { askId: ask.id, cell: ask.cell, label: reading.label, source: 'observation' });
      this.pendingObservation = cells;
      this.resumeWithReading(effects, ask.cell, reading);
    } else {
      this.pendingObservation = cells; // keep the freshest view for when the answer arrives
    }
  }

  private resumeWithReading(effects: Effect[], cell: number, reading: CellReading): void {
    const cells = [...(this.pendingObservation ?? [])];
    cells[cell] = reading;
    this.pendingAsk = null;
    this.pendingObservation = null;
    this.phase = this.resumePhase;
    this.handleBoard(effects, cells);
  }

  private applyResolution(effects: Effect[], resolution: Resolution, cells: CellReading[]): void {
    const game = this.game!;
    switch (resolution.kind) {
      case 'idle':
        break;

      case 'ask': {
        const ask: AskPayload = {
          id: `q${++this.askSeq}`,
          cell: resolution.cell,
          question: `I'm not sure about ${cellName(resolution.cell)} — what is drawn there?`,
          options: ['X', 'O', 'empty'],
        };
        this.resumePhase = this.phase as 'human_turn' | 'awaiting_agent_mark';
        this.phase = 'awaiting_answer';
        this.pendingAsk = ask;
        this.pendingObservation = cells;
        effects.push({ kind: 'ask', ask });
        this.log(effects, 'ask', { askId: ask.id, cell: ask.cell, observed: resolution.observed, expected: resolution.expected });
        break;
      }

      case 'human_move': {
        this.log(effects, 'human_move', { cell: resolution.cell, symbol: this.humanSymbol });
        if (!this.commitMove(effects, this.humanSymbol, resolution.cell)) {
          this.agentThink(effects);
        }
        break;
      }

      case 'agent_mark': {
        const announced = game.pendingAgentCell;
        game.pendingAgentCell = null;
        if (resolution.corrected && announced !== null) {
          this.say(
            effects,
            'correction',
            `I asked for ${cellName(announced)} but my ${this.agentSymbol} was drawn at ${cellName(resolution.cell)} — the ink stands, so that is my move.`,
          );
          this.log(effects, 'correction', { announced, drawn: resolution.cell });
        }
        this.log(effects, 'agent_mark_seen', { cell: resolution.cell, symbol: this.agentSymbol, corrected: resolution.corrected });
        const over = this.commitMove(effects, this.agentSymbol, resolution.cell);
        if (resolution.alsoHumanMove !== null) {
          if (over) {
            this.say(effects, 'warning', 'The game had already ended before that last mark — it is not part of the game.');
            this.log(effects, 'extra_mark_after_end', { cell: resolution.alsoHumanMove });
          } else {
            this.log(effects, 'human_move', { cell: resolution.alsoHumanMove, symbol: this.humanSymbol });
            if (!this.commitMove(effects, this.humanSymbol, resolution.alsoHumanMove)) {
              this.agentThink(effects);
            }
          }
        } else if (!over) {
          this.phase = 'human_turn';
          this.say(effects, 'prompt', `Your turn — draw ${symbolPhrase(this.humanSymbol)}.`);
        }
        break;
      }

      case 'reminder':
        if (resolution.text !== this.lastReminder) {
          this.lastReminder = resolution.text;
          this.say(effects, 'prompt', resolution.text);
        }
        break;

      case 'corrupt':
        this.corrupt(effects, resolution.reason);
        break;
    }
  }

  // ---- game lifecycle ------------------------------------------------------

  private startGame(effects: Effect[]): void {
    this.gameNumber += 1;
    this.clearAsk();
    this.lastReminder = null;
    const first = this.config.humanFirst ? this.humanSymbol : this.agentSymbol;
    this.game = {
      board: emptyBoard(),
      toMove: first,
      pendingAgentCell: null,
      history: [],
      result: null,
    };
    this.log(effects, 'game_start', { gameNumber: this.gameNumber, first });
    if (first === this.humanSymbol) {
      this.phase = 'human_turn';
      this.say(effects, 'prompt', `New game — you are ${this.humanSymbol} and you start. Draw your first mark.`);
    } else {
      this.say(effects, 'prompt', 'New game — I start.');
      this.agentThink(effects);
    }
  }

  /**
   * Ink is truth: a non-empty page with no active game (fresh process, or the
   * page re-appeared with history we never saw) is adopted as-is when it is a
   * reachable position, instead of demanding a fresh sheet.
   */
  private adoptBoard(effects: Effect[], cells: CellReading[]): void {
    const board: Board = cells.map((c) => (c.label === 'empty' ? null : c.label));
    const first = this.config.humanFirst ? this.humanSymbol : this.agentSymbol;
    if (!isConsistent(board, first)) {
      this.corrupt(effects, 'the marks on this page do not add up to a legal game');
      return;
    }
    this.gameNumber += 1;
    this.game = {
      board,
      toMove: whoseTurn(board, first),
      pendingAgentCell: null,
      history: [],
      result: null,
    };
    this.say(effects, 'info', 'Picking up the board as drawn.');
    this.log(effects, 'adopt', { gameNumber: this.gameNumber, board: board.map((c) => c ?? '.').join('') });

    const w = winner(board);
    if (w !== null || isFull(board)) {
      this.finishGame(effects, w);
      return;
    }
    if (this.game.toMove === this.agentSymbol) {
      this.agentThink(effects);
    } else {
      this.phase = 'human_turn';
      this.say(effects, 'prompt', `Your turn — draw ${symbolPhrase(this.humanSymbol)}.`);
    }
  }

  private agentThink(effects: Effect[]): void {
    const game = this.game!;
    const { move } = bestMove(game.board, this.agentSymbol);
    game.pendingAgentCell = move;
    game.toMove = this.agentSymbol;
    this.phase = 'awaiting_agent_mark';
    this.lastReminder = null;
    this.say(effects, 'move', `I play ${cellName(move)} — please draw ${symbolPhrase(this.agentSymbol)} there.`);
    this.log(effects, 'agent_move', { cell: move });
  }

  /** Applies a move to the committed board. Returns true when the game ended. */
  private commitMove(effects: Effect[], player: Player, cell: number): boolean {
    const game = this.game!;
    game.board = applyMove(game.board, cell, player);
    game.history.push({ player, cell });
    game.toMove = other(player);
    if (isTerminal(game.board)) {
      this.finishGame(effects, winner(game.board));
      return true;
    }
    return false;
  }

  private finishGame(effects: Effect[], w: Player | null): void {
    const game = this.game!;
    game.result = { winner: w, draw: w === null };
    game.pendingAgentCell = null;
    this.phase = 'game_over';
    const text =
      w === null
        ? "It's a draw. Show me a fresh grid to play again."
        : w === this.agentSymbol
          ? 'I win! Show me a fresh grid for a rematch.'
          : 'You win — well played! Show me a fresh grid for another round.';
    this.say(effects, 'result', text);
    this.log(effects, 'game_end', { gameNumber: this.gameNumber, winner: w, draw: w === null });
  }

  private corrupt(effects: Effect[], reason: string): void {
    this.log(effects, 'corrupt', { reason });
    this.game = null;
    this.clearAsk();
    this.phase = 'corrupted';
    this.say(effects, 'warning', `Something is off: ${reason}. Let's start over — show me a fresh 3×3 grid.`);
  }

  // ---- small helpers -------------------------------------------------------

  private clearAsk(): void {
    this.pendingAsk = null;
    this.pendingObservation = null;
  }

  private say(effects: Effect[], category: SayCategory, text: string): void {
    effects.push({ kind: 'say', category, text });
  }

  private log(effects: Effect[], type: string, event: Record<string, unknown>): void {
    effects.push({ kind: 'log', event: { type, ...event } });
  }
}
