import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import healthHandler from "./api/health.js";
import stateHandler from "./api/state.js";
import publicScorecardHandler from "./api/public-scorecard.js";
import publicCoordinatorHandler from "./api/public-coordinator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8000;

const API_ROUTES = new Map([
  ["/api/health", healthHandler],
  ["/api/state", stateHandler],
  ["/api/public-scorecard", publicScorecardHandler],
  ["/api/public-coordinator", publicCoordinatorHandler],
]);

const STATIC_ROUTES = new Map([
  ["/", "operator.html"],
  ["/operator", "operator.html"],
  ["/operator.html", "operator.html"],
  ["/index.html", "index.html"],
  ["/scorecard", "index.html"],
  ["/scorecard.html", "index.html"],
  ["/coordinator", "coordinator.html"],
  ["/coordinator.html", "coordinator.html"],
  ["/public-scorecard", "public-scorecard.html"],
  ["/public-scorecard.html", "public-scorecard.html"],
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".mov", "video/quicktime"],
  [".txt", "text/plain; charset=utf-8"],
]);

function safeJoinProjectPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const absolutePath = path.resolve(__dirname, `.${normalizedPath}`);
  if (!absolutePath.startsWith(__dirname)) {
    return null;
  }
  return absolutePath;
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function createNodeResponseBridge(response) {
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (payload) => {
    if (!response.hasHeader("Content-Type")) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify(payload));
    return response;
  };
  response.send = (payload) => {
    if (payload == null) {
      response.end();
      return response;
    }
    if (Buffer.isBuffer(payload) || typeof payload === "string") {
      response.end(payload);
      return response;
    }
    if (!response.hasHeader("Content-Type")) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify(payload));
    return response;
  };
  return response;
}

async function handleApiRequest(request, response, handler) {
  const bridgedResponse = createNodeResponseBridge(response);
  const rawBody = await collectRequestBody(request);
  let parsedBody = rawBody;

  const contentType = String(request.headers["content-type"] || "");
  if (rawBody && contentType.includes("application/json")) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      bridgedResponse.status(400).json({
        error: "invalid_json",
        message: "Request body is not valid JSON.",
      });
      return;
    }
  }

  request.body = parsedBody;
  await handler(request, bridgedResponse);
}

function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function serveStaticFile(requestPath, response) {
  const routeTarget = STATIC_ROUTES.get(requestPath) || requestPath.slice(1);
  const targetPath = safeJoinProjectPath(`/${routeTarget}`);
  if (!targetPath) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  fs.stat(targetPath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("Not Found");
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypeFor(targetPath));
    if (path.extname(targetPath).toLowerCase() === ".html") {
      response.setHeader("Cache-Control", "no-store");
    }

    const stream = fs.createReadStream(targetPath);
    stream.on("error", () => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      response.end("Internal Server Error");
    });
    stream.pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    if (API_ROUTES.has(pathname)) {
      await handleApiRequest(request, response, API_ROUTES.get(pathname));
      return;
    }

    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end("Method Not Allowed");
      return;
    }

    serveStaticFile(pathname, response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "local_server_error",
      message: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Wild Hog Timekeeper local server running at http://${HOST}:${PORT}/`);
  console.log(`Local operator app: http://${HOST}:${PORT}/operator`);
  console.log(`Public scorecard preview: http://${HOST}:${PORT}/scorecard`);
  console.log(`Coordinator board: http://${HOST}:${PORT}/coordinator`);
  console.log(`Health check: http://${HOST}:${PORT}/api/health`);
});
