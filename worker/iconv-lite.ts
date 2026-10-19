// A minimal stand-in for `iconv-lite`, used only by the Worker bundle (see "alias" in
// wrangler.jsonc).
//
// Express does `exports.json = bodyParser.json` the moment it is imported, and body-parser lazily
// loads raw-body, which requires iconv-lite. iconv-lite 0.4 ships a browser build that maps its
// `./streams` module to `false`, so on workerd the very first character-conversion call throws:
//
//     TypeError: require_streams(...) is not a function
//
// That happens during module initialisation, before any request is handled, so the Worker cannot
// start at all. Nothing in this API needs a legacy charset (apps/api/src/body.ts parses JSON
// itself), so this shim covers the encodings that can realistically appear and refuses the rest
// with the same message raw-body expects so it still answers 415.
const ENCODINGS: Record<string, BufferEncoding | undefined> = {
  utf8: 'utf8', utf: 'utf8', unicode11utf8: 'utf8', unicode20utf8: 'utf8', xunicode20utf8: 'utf8',
  latin1: 'latin1', binary: 'latin1', iso88591: 'latin1', ascii: 'latin1', usascii: 'latin1',
  utf16le: 'utf16le', ucs2: 'utf16le', utf16: 'utf16le',
};

function resolve(encoding?: string | null): BufferEncoding | undefined {
  return ENCODINGS[String(encoding ?? '').toLowerCase().replace(/[\s_\-.]/g, '')];
}

export function encodingExists(encoding: string): boolean {
  return resolve(encoding) !== undefined;
}

export function decode(buffer: Buffer, encoding?: string): string {
  const enc = resolve(encoding) ?? 'utf8';
  return Buffer.from(buffer).toString(enc);
}

export function getDecoder(encoding?: string) {
  if (!encoding) return null;
  const enc = resolve(encoding);
  // The message must match raw-body's ICONV_ENCODING_MESSAGE_REGEXP so it reports 415, not 500.
  if (!enc) throw new Error(`Encoding not recognized: '${encoding}'`);
  return {
    write: (chunk: Buffer) => chunk.toString(enc),
    end: () => '',
  };
}

export function getEncoder(encoding?: string) {
  if (!encoding) return null;
  const enc = resolve(encoding);
  if (!enc) throw new Error(`Encoding not recognized: '${encoding}'`);
  return {
    write: (str: string) => Buffer.from(str, enc),
    end: () => Buffer.alloc(0),
  };
}

export default { encodingExists, decode, getDecoder, getEncoder };
