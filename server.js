import express from "express";
import cors from "cors";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── R2 Client ───────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT, // https://<account_id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME; // e.g. "argpt-previews"
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. "https://previews.yourdomain.com"

// ─── Simple Queue ─────────────────────────────────────────────────────────────
const queue = [];
let isBuilding = false;

async function processQueue() {
  if (isBuilding || queue.length === 0) return;
  isBuilding = true;
  const { projectId, files, resolve, reject } = queue.shift();
  try {
    const url = await buildProject(projectId, files);
    resolve(url);
  } catch (e) {
    reject(e);
  } finally {
    isBuilding = false;
    processQueue(); // next in queue
  }
}

function enqueue(projectId, files) {
  return new Promise((resolve, reject) => {
    queue.push({ projectId, files, resolve, reject });
    processQueue();
  });
}

// ─── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// ─── Build Logic ─────────────────────────────────────────────────────────────
async function buildProject(projectId, files) {
  const tmpDir = `/tmp/build-${randomUUID()}`;

  try {
    // 1. Write files to temp dir
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content, "utf8");
    }

    // 2. Install deps
    console.log(`[Build] Installing deps for ${projectId}...`);
    execSync("npm install --prefer-offline", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 120000,
    });

    // 3. Vite build
    console.log(`[Build] Building ${projectId}...`);
    execSync("npx vite build", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 120000,
      env: { ...process.env, NODE_ENV: "production" },
    });

    // 4. Upload dist/ to R2
    const distDir = join(tmpDir, "dist");
    const prefix = `previews/${projectId}`;
    await uploadDir(distDir, distDir, prefix);

    const previewUrl = `${R2_PUBLIC_URL}/${prefix}/index.html`;
    console.log(`[Build] ✅ Done: ${previewUrl}`);
    return previewUrl;

  } finally {
    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Upload directory recursively to R2
async function uploadDir(baseDir, currentDir, prefix) {
  const entries = readdirSync(currentDir);
  for (const entry of entries) {
    const fullPath = join(currentDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      await uploadDir(baseDir, fullPath, prefix);
    } else {
      const relativePath = fullPath.replace(baseDir + "/", "");
      const key = `${prefix}/${relativePath}`;
      const content = readFileSync(fullPath);
      const ext = extname(fullPath);
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: content,
        ContentType: MIME[ext] || "application/octet-stream",
        CacheControl: "public, max-age=31536000",
      }));
    }
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, queue: queue.length, building: isBuilding });
});

// Build endpoint
app.post("/build", async (req, res) => {
  const { projectId, files, secret } = req.body;

  // Simple auth
  if (secret !== process.env.BUILD_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!projectId || !files?.length) {
    return res.status(400).json({ error: "projectId and files required" });
  }

  const queuePosition = queue.length;

  try {
    const url = await enqueue(projectId, files);
    res.json({ success: true, url });
  } catch (e) {
    console.error("[Build] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Queue status
app.get("/queue", (req, res) => {
  res.json({ queue: queue.length, building: isBuilding });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Server] Build server running on port ${PORT}`);
});
