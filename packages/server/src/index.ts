export const SERVER_NAME = '@vistactoe/server';

export { GameSession } from './session/machine.js';
export { resolveBoard, type ResolveInput, type Resolution } from './session/resolver.js';
export { SessionPipeline, type LogSink } from './pipeline.js';
export { buildServer, type BuildOptions } from './app.js';
export { loadConfig, type ServerConfig } from './config.js';
export { createOpenRouterClient, type VlmClient, type VlmVerdict, type OpenRouterOptions } from './vlm.js';
export {
  applyCalibration,
  emptyCalibration,
  toFeatureVector,
  updateCalibration,
  type Calibration,
  type FeatureVector,
  type LabeledExample,
} from './feedback/calibration.js';
export { extractLearning, FeedbackStore, summarize, type FeedbackEvent, type GameSummary } from './feedback/store.js';
export { buildReport } from './feedback/report.js';
