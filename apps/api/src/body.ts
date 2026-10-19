// A tiny JSON body parser.
//
// Express ships `express.json()`, but that pulls in body-parser → raw-body → iconv-lite, and
// iconv-lite's browser build replaces its `./streams` module with `false`, which throws on
// Cloudflare Workers (`require_streams(...) is not a function`). The API only ever accepts JSON, so
// reading the stream ourselves keeps the Worker small and free of that dependency.
import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

const MAX_BYTES = 100 * 1024;

export const jsonBody: RequestHandler = (req, _res, next) => {
  const body = req as typeof req & { body?: unknown };
  if (req.method === 'GET' || req.method === 'HEAD') { body.body = {}; return next(); }

  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BYTES) chunks.push(chunk); });
  req.on('error', (err: Error) => next(err));
  req.on('end', () => {
    if (size > MAX_BYTES) return next(new AppError('VALIDATION_ERROR', 'Request body is too large.'));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) { body.body = {}; return next(); }
    try { body.body = JSON.parse(raw); }
    catch { return next(new AppError('VALIDATION_ERROR', 'Request body must be valid JSON.')); }
    next();
  });
};
