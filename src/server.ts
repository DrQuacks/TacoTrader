import http, { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendText(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  message: string,
): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendFile(filePath: string, res: ServerResponse<IncomingMessage>): void {
  readFile(filePath, (error, data) => {
    if (error) {
      const isMissing = error.code === "ENOENT";
      sendText(res, isMissing ? 404 : 500, isMissing ? "Not found" : "Server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    });
    res.end(data);
  });
}

function getSafeFilePath(urlPath: string | undefined): string {
  const requestPath = urlPath === "/" || !urlPath ? "/index.html" : urlPath;
  const normalizedPath = path.normalize(requestPath).replace(/^[/\\]+/, "");
  const safePath = normalizedPath.replace(/^(\.\.[/\\])+/, "");
  return path.join(PUBLIC_DIR, safePath);
}

http
  .createServer((req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    const filePath = getSafeFilePath(req.url);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    sendFile(filePath, res);
  })
  .listen(PORT, HOST, () => {
    console.log(`TACO Trader is running at http://${HOST}:${PORT}`);
  });
