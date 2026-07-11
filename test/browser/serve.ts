/**
 * Minimal static server for browser gate tests. WebGPU requires a secure
 * context — about:blank is NOT one in Chromium — so pages are served on
 * http://127.0.0.1 (a trustworthy origin). Serves repo files (dist/, test
 * pages) with correct MIME types; no external deps.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".wasm": "application/wasm",
};

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Serve the repository root on an ephemeral 127.0.0.1 port. */
export async function serveRepo(): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(REPO, rel));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      // Exercise the cross-origin-isolated (SAB) path where tests opt in.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
