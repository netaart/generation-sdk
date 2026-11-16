import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import sirv from "sirv";
import type { GenerationMediaFetch } from "../../src/index.js";

export const MEDIA_FIXTURES = fileURLToPath(new URL("../fixtures/media/", import.meta.url));

export type MediaServer = {
  /** URL of a fixture file. */
  url(path: string): string;
  /** Range headers the server received, by path. */
  ranges(path: string): string[];
  close(): Promise<void>;
};

/**
 * Serves test/fixtures/media over HTTP with Range support. Extra paths:
 * `/status/<code>` answers with that status, `/no-range/<file>` ignores Range headers,
 * `/redirect/<file>` redirects to the file.
 */
export async function startMediaServer(): Promise<MediaServer> {
  const serveFile = sirv(MEDIA_FIXTURES, { dev: true });
  const ranges = new Map<string, string[]>();
  const record = (request: IncomingMessage) => {
    const path = request.url ?? "/";
    ranges.set(path, [...(ranges.get(path) ?? []), request.headers.range ?? ""]);
  };
  const server: Server = createServer((request, response) => {
    record(request);
    const path = request.url ?? "/";
    const status = path.match(/^\/status\/(\d+)$/)?.[1];
    if (status) {
      response.writeHead(Number(status)).end("error page");
      return;
    }
    if (path.startsWith("/redirect/")) {
      response.writeHead(302, { location: `/${path.slice("/redirect/".length)}` }).end();
      return;
    }
    if (path.startsWith("/no-range/")) {
      response.writeHead(200);
      createReadStream(`${MEDIA_FIXTURES}${path.slice("/no-range/".length)}`).pipe(response);
      return;
    }
    serveFile(request, response, () => {
      response.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}/${path}`,
    ranges: (path) => ranges.get(`/${path}`) ?? [],
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** Reads test media with the built-in fetch; the default media fetch refuses the loopback test server. */
export const loopbackMediaFetch: GenerationMediaFetch = (url, init) => fetch(url, init);
