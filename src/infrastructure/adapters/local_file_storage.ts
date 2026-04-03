import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import type {
  IFileStorage,
  SaveClientThumbnailInput,
  SaveClientThumbnailResult,
} from "../../domain/ports/file_storage.port";

const mimeToExt: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface LocalFileStorageConfig {
  readonly uploadsDir: string;
  readonly uploadsPublicBaseUrl: string;
  readonly clientThumbnailWidth: number;
  readonly clientThumbnailHeight: number;
  readonly clientThumbnailWebpQuality: number;
}

export class LocalFileStorage implements IFileStorage {
  constructor(private readonly config: LocalFileStorageConfig) {}

  async saveClientThumbnail(input: SaveClientThumbnailInput): Promise<SaveClientThumbnailResult> {
    if (!Object.hasOwn(mimeToExt, input.mimeType)) {
      throw new Error("Unsupported thumbnail MIME type");
    }
    const ext = "webp";

    let normalized: Buffer;
    try {
      normalized = await sharp(input.buffer, { animated: false })
        .rotate()
        .resize(this.config.clientThumbnailWidth, this.config.clientThumbnailHeight, {
          fit: "cover",
          position: "centre",
        })
        .webp({ quality: this.config.clientThumbnailWebpQuality })
        .toBuffer();
    } catch {
      throw new Error("Invalid thumbnail image file");
    }

    const segment = "client-thumbnails";
    const filename = `${input.clientId}-${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
    const absoluteDir = path.resolve(this.config.uploadsDir, segment);
    const absolutePath = path.join(absoluteDir, filename);
    await mkdir(absoluteDir, { recursive: true });
    await writeFile(absolutePath, normalized);

    const storageKey = `${segment}/${filename}`;
    const base = this.config.uploadsPublicBaseUrl.replace(/\/+$/, "");
    return {
      url: `${base}/${storageKey}`,
      storageKey,
    };
  }

  async delete(storageKey: string): Promise<void> {
    const normalized = storageKey.replace(/\\/g, "/");
    const absolutePath = path.resolve(this.config.uploadsDir, normalized);
    await rm(absolutePath, { force: true });
  }
}
