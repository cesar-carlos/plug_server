export interface SaveClientThumbnailInput {
  readonly clientId: string;
  readonly buffer: Buffer;
  readonly mimeType: string;
}

export interface SaveClientThumbnailResult {
  readonly url: string;
  readonly storageKey: string;
}

export interface IFileStorage {
  saveClientThumbnail(input: SaveClientThumbnailInput): Promise<SaveClientThumbnailResult>;
  delete(storageKey: string): Promise<void>;
}
