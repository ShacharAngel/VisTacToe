import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Calibration } from './calibration.js';
import type { GameSummary } from './store.js';

/** Human-readable trend report over the persisted per-game summaries. */
export function buildReport(dataDir: string): string {
  const gamesDir = path.join(dataDir, 'games');
  if (!existsSync(gamesDir)) return `No games recorded yet under ${dataDir}/.`;

  const summaries: GameSummary[] = [];
  for (const entry of readdirSync(gamesDir).sort()) {
    const file = path.join(gamesDir, entry, 'summary.json');
    if (existsSync(file)) {
      summaries.push(JSON.parse(readFileSync(file, 'utf8')) as GameSummary);
    }
  }
  if (summaries.length === 0) return `No completed games under ${dataDir}/games/.`;

  const lines: string[] = [];
  lines.push('game  result       moves  asks  confirmed  misreads  vlm  corrections  corrupts');
  for (const [i, s] of summaries.entries()) {
    const result = s.draw ? 'draw' : s.winner ? `${s.winner} wins` : '(unfinished)';
    lines.push(
      [
        String(i + 1).padEnd(6),
        result.padEnd(13),
        String(s.moves).padEnd(7),
        String(s.asks).padEnd(6),
        String(s.asksConfirmed).padEnd(11),
        String(s.misreads).padEnd(10),
        String(s.vlmCalls).padEnd(5),
        String(s.corrections).padEnd(13),
        String(s.corrupts),
      ].join(''),
    );
  }

  const first = summaries[0]!;
  const last = summaries.at(-1)!;
  lines.push('');
  lines.push(
    `Interventions per game (asks + corrections): first=${first.asks + first.corrections}, latest=${last.asks + last.corrections}.`,
  );

  const calibrationFile = path.join(dataDir, 'calibration.json');
  if (existsSync(calibrationFile)) {
    const calibration = JSON.parse(readFileSync(calibrationFile, 'utf8')) as Calibration;
    lines.push(
      `Calibration: ${calibration.gamesLearned} game(s) learned, ` +
        `ask threshold=${calibration.thresholds.ask ?? 'default'}, ` +
        `X examples=${calibration.marks.X?.count ?? 0}, O examples=${calibration.marks.O?.count ?? 0}.`,
    );
  }
  lines.push('');
  lines.push(`Raw, inspectable state: ${dataDir}/games/*/events.jsonl, ${dataDir}/calibration.json`);
  return lines.join('\n');
}
