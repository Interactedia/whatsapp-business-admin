import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Media storage abstraction. The local implementation writes under MEDIA_DIR.
 * Swap this for an S3-backed store later without touching callers.
 */
export interface MediaStore {
  /** Persist bytes; returns an opaque relative path stored in the DB. */
  save(data: Buffer, ext: string): Promise<string>;
  /** Read bytes back by the stored path. */
  read(relPath: string): Promise<Buffer>;
}

const MEDIA_DIR = path.resolve(/* turbopackIgnore: true */ process.env.MEDIA_DIR || "./storage/media");

class LocalMediaStore implements MediaStore {
  async save(data: Buffer, ext: string): Promise<string> {
    const now = new Date();
    const sub = path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
    const dir = path.join(/* turbopackIgnore: true */ MEDIA_DIR, sub);
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomBytes(12).toString("hex")}${ext ? `.${ext.replace(/^\./, "")}` : ""}`;
    const rel = path.join(sub, name);
    await fs.writeFile(path.join(/* turbopackIgnore: true */ MEDIA_DIR, rel), data);
    return rel;
  }

  async read(relPath: string): Promise<Buffer> {
    // Guard against path traversal — resolved path must stay under MEDIA_DIR.
    const full = path.resolve(MEDIA_DIR, relPath);
    if (!full.startsWith(MEDIA_DIR + path.sep)) throw new Error("Invalid media path");
    return fs.readFile(/* turbopackIgnore: true */ full);
  }
}

export const mediaStore: MediaStore = new LocalMediaStore();

/** Best-effort file extension from a MIME type. */
export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "application/pdf": "pdf",
    "application/vnd.ms-excel": "xls",
    "application/msword": "doc",
  };
  return map[mime] ?? mime.split("/")[1]?.split(";")[0] ?? "bin";
}
