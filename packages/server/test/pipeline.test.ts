import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage, SessionSnapshot } from '@vistactoe/shared';
import { createAnalyzer, encodeGrayToJpeg, synthetic, type Analyzer } from '@vistactoe/vision';
import { defaultConfig, mergeConfig } from '@vistactoe/shared';
import { SessionPipeline } from '@vistactoe/server';

const { renderPaper, renderScene, defaultQuad } = synthetic;

let analyzer: Analyzer;

beforeAll(async () => {
  analyzer = await createAnalyzer();
}, 30_000);

async function jpegFrame(marks: string, noiseSeed: number): Promise<string> {
  const scene = renderScene({ quad: defaultQuad(), paper: renderPaper({ marks, seed: 7 }), seed: noiseSeed });
  return (await encodeGrayToJpeg(scene)).toString('base64');
}

function lastSnapshot(messages: ServerMessage[]): SessionSnapshot | null {
  const snap = [...messages].reverse().find((m) => m.type === 'snapshot');
  return snap?.type === 'snapshot' ? snap.snapshot : null;
}

describe('SessionPipeline', () => {
  it('drives frames end to end: empty grid starts the game, a mark gets answered', async () => {
    const pipeline = new SessionPipeline(analyzer, mergeConfig({ stability: { ...defaultConfig.stability, stillFrames: 3 } }));

    // Feed stable empty-grid frames until the game starts.
    let started: SessionSnapshot | null = null;
    for (let seed = 1; seed <= 6 && !started?.gameNumber; seed++) {
      const messages = await pipeline.handleFrame(await jpegFrame('.........', seed));
      const snap = lastSnapshot(messages);
      if (snap && snap.gameNumber > 0) started = snap;
    }
    expect(started?.phase).toBe('human_turn');

    // The human draws an X in the corner; the agent must announce a reply.
    let announced: SessionSnapshot | null = null;
    const allSays: string[] = [];
    for (let seed = 10; seed <= 16 && !announced; seed++) {
      const messages = await pipeline.handleFrame(await jpegFrame('X........', seed));
      allSays.push(...messages.filter((m) => m.type === 'say').map((m) => (m.type === 'say' ? m.text : '')));
      const snap = lastSnapshot(messages);
      if (snap?.phase === 'awaiting_agent_mark') announced = snap;
    }
    expect(announced).not.toBeNull();
    expect(announced!.pendingAgentCell).toBe(4); // perfect play answers the corner with the center
    expect(allSays.some((t) => t.includes('B2'))).toBe(true);
    expect(announced!.board[0]).toBe('X');
  }, 30_000);

  it('emits nothing for unchanged frames once settled', async () => {
    const pipeline = new SessionPipeline(analyzer, mergeConfig({ stability: { ...defaultConfig.stability, stillFrames: 3 } }));
    for (let seed = 1; seed <= 6; seed++) {
      await pipeline.handleFrame(await jpegFrame('.........', seed));
    }
    const quiet = await pipeline.handleFrame(await jpegFrame('.........', 50));
    expect(quiet).toHaveLength(0);
  }, 30_000);
});
