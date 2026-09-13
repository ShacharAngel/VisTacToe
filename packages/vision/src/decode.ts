import sharp from 'sharp';
import type { GrayImage } from './types.js';

/** Decode an encoded camera frame (JPEG/PNG) to grayscale. */
export async function decodeToGray(encoded: Buffer | Uint8Array): Promise<GrayImage> {
  const { data, info } = await sharp(encoded).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Encode a grayscale image as JPEG (fixtures, feedback snapshots, VLM crops). */
export async function encodeGrayToJpeg(img: GrayImage, quality = 85): Promise<Buffer> {
  return sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 1 } })
    .jpeg({ quality })
    .toBuffer();
}

/** Encode a grayscale image as PNG (lossless — for inspecting binary masks). */
export async function encodeGrayToPng(img: GrayImage): Promise<Buffer> {
  return sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 1 } })
    .png()
    .toBuffer();
}
