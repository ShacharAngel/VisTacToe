import { createRequire } from 'node:module';
import type cvTypes from '@techstark/opencv-js';

export type CvModule = typeof cvTypes;

let ready: Promise<CvModule> | null = null;

/**
 * The wasm build is a CommonJS emscripten module whose export is a *thenable*,
 * which breaks ESM import interop (Vite tries to await the module namespace).
 * Loading through createRequire avoids that; we then wait for the runtime via
 * whichever handshake this build exposes (thenable or onRuntimeInitialized).
 */
export function loadOpenCv(): Promise<CvModule> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const cv = require('@techstark/opencv-js') as {
      then?: (onFulfilled: () => void) => void;
      onRuntimeInitialized?: () => void;
      Mat?: unknown;
    };
    if (typeof cv.then === 'function') {
      await new Promise<void>((resolve) => cv.then!(resolve));
    } else if (!cv.Mat) {
      await new Promise<void>((resolve) => {
        cv.onRuntimeInitialized = resolve;
      });
    }
    return cv as unknown as CvModule;
  })();
  return ready;
}
