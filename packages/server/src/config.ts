import { readFileSync } from 'node:fs';
import { mergeConfig, type AppConfig, type DeepPartial } from '@vistactoe/shared';

export interface ServerConfig {
  app: AppConfig;
  /** Present only when the VLM tier may actually be used. */
  openRouterApiKey: string | null;
}

/**
 * Config precedence: defaults ← optional config.json ← environment.
 * The VLM tier silently disables itself without an API key, so the system
 * runs fully offline out of the box.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let fileConfig: DeepPartial<AppConfig> = {};
  const path = env.VISTACTOE_CONFIG ?? 'config.json';
  try {
    fileConfig = JSON.parse(readFileSync(path, 'utf8')) as DeepPartial<AppConfig>;
  } catch {
    // No config file is the normal case.
  }

  const app = mergeConfig(fileConfig);
  const envPort = Number(env.PORT);
  if (Number.isInteger(envPort) && envPort > 0) app.port = envPort;
  if (env.VLM_ENABLED) app.vlm.enabled = env.VLM_ENABLED === 'true';

  const openRouterApiKey = env.OPENROUTER_API_KEY ?? null;
  if (!openRouterApiKey) app.vlm.enabled = false;

  return { app, openRouterApiKey };
}
