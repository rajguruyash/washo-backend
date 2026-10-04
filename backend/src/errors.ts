import { z } from 'zod';

/** An error that is safe to show to the client. `code` is stable and machine-readable. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);

/** Validates untrusted input, turning zod issues into a 400 with per-field messages. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  throw new HttpError(400, 'validation_error', 'Please check the highlighted fields.', { fields });
}

/**
 * The database raises plain-English messages for every rule it enforces (RAISE EXCEPTION), which is exactly what a
 * customer should read. Anything that is not one of those is treated as a server fault and not leaked.
 */
export function fromPg(err: unknown): HttpError | null {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case 'P0001': // raise_exception
      if (/^Unauthorized|^Only (authenticated )?workers|^Not authorized/i.test(e.message ?? '')) {
        return new HttpError(403, 'forbidden', 'You do not have access to that.');
      }
      return new HttpError(/not found/i.test(e.message ?? '') ? 404 : 422, 'rule', e.message ?? 'Not allowed');
    case '42501': // insufficient_privilege (also RLS violations)
      return new HttpError(403, 'forbidden', 'You do not have access to that.');
    case '23505':
      return new HttpError(409, 'duplicate', 'That already exists.');
    case '23503':
      return new HttpError(409, 'in_use', 'That is still in use.');
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22008':
    case '22023':
    case '22003':
      return new HttpError(400, 'invalid', 'Some of that information is not valid.');
    case '42883': // undefined_function
    case '42P01': // undefined_table
    case '42703': // undefined_column
      // The website is newer than this database. Say so plainly to the person, and loudly to whoever runs the server.
      console.error(`DATABASE IS MISSING SOMETHING THE WEBSITE NEEDS (${e.message}). Apply supabase/migrations/* in order.`);
      return new HttpError(503, 'backend_not_ready', "This part of WASHO isn't switched on yet. Please try again later, or contact WASHO.");
    case '57014': // statement_timeout
      return new HttpError(503, 'timeout', 'That took too long. Please try again.');
    default:
      return null;
  }
}
