import { createServer, Server } from 'node:http';

/**
 * A local stand-in for Cloudflare R2, for the KYC document specs.
 *
 * .env.e2e points R2_ENDPOINT at port 41101 (path-style), so the server's
 * S3 client PUTs uploads here and GETs them back for the admin streaming
 * route. The AWS SDK needs remarkably little to be satisfied: a 200 with an
 * ETag header for PutObject, and a 200 with Content-Type/Content-Length and
 * the bytes for GetObject — no signature checking, no XML.
 *
 * Port 41101, NOT the leads fixtures' 41100: the suite is serial (workers: 1)
 * but keeping the two surfaces on separate ports means a leads spec and a KYC
 * spec can never trip over each other's listen(). The same rule applies here
 * as there: a spec file that starts this in beforeAll MUST close it in
 * afterAll, or the next file's listen() dies on EADDRINUSE.
 */

export const R2_FIXTURE_PORT = 41101;

/** R2_BUCKET_NAME in .env.e2e — the first path segment of every S3 request. */
export const R2_FIXTURE_BUCKET = 'e2e-kyc-bucket';

/** R2_PUBLIC_URL in .env.e2e — the prefix of every stored kycDocumentPath. */
export const R2_FIXTURE_PUBLIC_URL = `http://127.0.0.1:${R2_FIXTURE_PORT}/public`;

export interface StoredR2Object {
  body: Buffer;
  contentType: string;
}

/**
 * The fixture path an uploaded document lands under.
 *
 * The row stores `${R2_PUBLIC_URL}/${key}`; the S3 client addresses the same
 * object path-style as `/${bucket}/${key}`. This maps the former to the
 * latter so a spec can look an upload up by the URL the database holds.
 */
export function r2ObjectPath(documentUrl: string): string {
  const key = documentUrl.slice(`${R2_FIXTURE_PUBLIC_URL}/`.length);
  return `/${R2_FIXTURE_BUCKET}/${key}`;
}

/**
 * Unwraps an `aws-chunked` request body.
 *
 * Newer AWS SDKs may send PutObject payloads with checksum trailers, framed
 * as `<hex length>[;ext]\r\n<bytes>\r\n … 0\r\n<trailers>`. Storing that
 * framing verbatim would corrupt the object, so it is decoded when the
 * Content-Encoding header announces it and passed through untouched
 * otherwise.
 */
function decodeAwsChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const sizeLine = raw.subarray(offset, lineEnd).toString('ascii');
    const size = parseInt(sizeLine.split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    parts.push(raw.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2; // skip the chunk's trailing \r\n
  }
  return Buffer.concat(parts);
}

export function startR2FixtureServer(): Promise<{
  /** Everything PUT so far, keyed by request path (`/bucket/key…`). */
  objects: Map<string, StoredR2Object>;
  close(): Promise<void>;
}> {
  const objects = new Map<string, StoredR2Object>();

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url ?? '/', `http://127.0.0.1:${R2_FIXTURE_PORT}`).pathname,
    );
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') {
        let body: Buffer = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) {
          body = decodeAwsChunked(body);
        }
        objects.set(path, {
          body,
          contentType: String(
            req.headers['content-type'] ?? 'application/octet-stream',
          ),
        });
        res.writeHead(200, { ETag: '"e2e-r2-fixture"', Connection: 'close' });
        res.end();
        return;
      }

      if (req.method === 'GET') {
        const stored = objects.get(path);
        if (!stored) {
          res.writeHead(404, {
            'Content-Type': 'application/xml',
            Connection: 'close',
          });
          res.end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        res.writeHead(200, {
          'Content-Type': stored.contentType,
          'Content-Length': stored.body.length,
          Connection: 'close',
        });
        res.end(stored.body);
        return;
      }

      res.writeHead(405, { Connection: 'close' });
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(R2_FIXTURE_PORT, '127.0.0.1', () => {
      resolve({
        objects,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            // The API server's S3 client keeps its sockets alive; without
            // this, close() waits on them past the test timeout.
            server.closeAllConnections();
          }),
      });
    });
  });
}
