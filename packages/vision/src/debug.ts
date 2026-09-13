import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Analyzer } from './acquire.js';
import { encodeGrayToPng } from './decode.js';
import type { GrayImage } from './types.js';

/**
 * Dev-only inspection helper: dumps what the CV pipeline sees for a frame so a
 * failing paper/grid detection can be eyeballed. Rotates a small ring of files
 * so it never fills the disk. Enabled by the server when VISTACTOE_DEBUG is set.
 */
export class VisionDebugDumper {
  private frames = 0;
  private saved = 0;

  constructor(
    private readonly analyzer: Analyzer,
    private readonly dir: string,
    private readonly everyNFrames = 4,
    private readonly ringSize = 8,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async maybeDump(frame: GrayImage): Promise<void> {
    if (this.frames++ % this.everyNFrames !== 0) return;
    const slot = this.saved++ % this.ringSize;

    const quad = this.analyzer.findPaperQuad(frame);
    const kind = !quad ? 'no_paper' : this.analyzer.detectGrid(this.analyzer.rectify(frame, quad)) ? 'grid' : 'no_grid';

    await this.write(`frame-${slot}-${kind}.png`, frame);
    if (quad) {
      const rectified = this.analyzer.rectify(frame, quad);
      await this.write(`rect-${slot}-${kind}.png`, rectified);
      await this.write(`ink-${slot}-${kind}.png`, this.analyzer.inkMask(rectified));
    }
    writeFileSync(
      path.join(this.dir, `frame-${slot}.json`),
      JSON.stringify({ kind, quad, size: { w: frame.width, h: frame.height } }, null, 2),
    );
  }

  private async write(name: string, img: GrayImage): Promise<void> {
    writeFileSync(path.join(this.dir, name), await encodeGrayToPng(img));
  }
}
