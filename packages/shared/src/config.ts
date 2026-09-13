import type { Player } from '@vistactoe/engine';

export interface AppConfig {
  port: number;
  /** Whether the human takes the first move of each game. */
  humanFirst: boolean;
  humanSymbol: Player;
  confidence: {
    /** Below this, a cell reading that contradicts the committed board escalates (VLM tier, then ask the human). */
    ask: number;
  };
  stability: {
    /** Consecutive still frames required before the board is read. */
    stillFrames: number;
    /** Fraction of changed pixels above which a frame counts as motion. */
    motionThreshold: number;
  };
  vlm: {
    enabled: boolean;
    /** OpenRouter model IDs, tried in order via the models[] routing array. */
    models: string[];
    timeoutMs: number;
  };
}

export const defaultConfig: AppConfig = {
  port: 3000,
  humanFirst: true,
  humanSymbol: 'X',
  confidence: {
    ask: 0.6,
  },
  stability: {
    stillFrames: 5,
    motionThreshold: 0.02,
  },
  vlm: {
    enabled: false,
    models: ['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna'],
    timeoutMs: 4000,
  },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function mergeConfig(partial?: DeepPartial<AppConfig>): AppConfig {
  return {
    ...defaultConfig,
    ...partial,
    confidence: { ...defaultConfig.confidence, ...partial?.confidence },
    stability: { ...defaultConfig.stability, ...partial?.stability },
    vlm: {
      ...defaultConfig.vlm,
      ...partial?.vlm,
      models: partial?.vlm?.models ?? [...defaultConfig.vlm.models],
    },
  };
}
