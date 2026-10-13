import { photoStorage } from './supabase';

/** What kind of picture these bytes are, from the bytes themselves (never from what the browser said). Null if it is not a JPG, PNG or WebP. */
export const sniffImage = (b: Buffer): { mime: string; ext: string } | null => {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
};

interface RawAttachment { id: string; storage_path: string; content_type: string }
interface RawMessage { attachments?: RawAttachment[] | null; [k: string]: unknown }

/**
 * A complaint's messages as the database returned them (each with the pictures it was sent with), with each picture's file path swapped for a short-lived link. The path
 * never leaves the server. A database without pictures yet (migration 41) returns messages with no pictures, which is handled here.
 */
export async function withPictureLinks<T extends RawMessage>(messages: T[]): Promise<(Omit<T, 'attachments'> & { attachments: { id: string; content_type: string; url: string | null }[] })[]> {
  return Promise.all(
    messages.map(async ({ attachments, ...m }) => ({
      ...m,
      attachments: await Promise.all((attachments ?? []).map(async (a) => ({ id: a.id, content_type: a.content_type, url: await photoStorage.signedUrl(a.storage_path) }))),
    }))
  );
}

/** The database does not have pictures in complaints yet (migration 41 is not applied): say so instead of a stack trace. */
export const picturesNotInstalled = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === '42883' || code === '42P01';
};
