import express from "express";
import cors from "cors";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { execSync, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, cpSync, existsSync } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── B2 Client ────────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ─── Pre-install base dependencies on startup ─────────────────────────────────
const BASE_MODULES_DIR = "/tmp/base-node-modules";

function setupBaseModules() {
  if (existsSync(BASE_MODULES_DIR + "/node_modules")) {
    console.log("[Setup] Base node_modules already exists, skipping install.");
    return;
  }

  console.log("[Setup] Installing base dependencies...");
  mkdirSync(BASE_MODULES_DIR, { recursive: true });

  const basePkg = {
    name: "base-template",
    version: "1.0.0",
    type: "module",
    dependencies: {
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "react-router-dom": "^6.26.2",
      "@vitejs/plugin-react-swc": "^3.5.0",
      "vite": "^5.4.19",
      "typescript": "^5.5.3",
      "tailwindcss": "^3.4.11",
      "autoprefixer": "^10.4.20",
      "postcss": "^8.4.47",
      "tailwind-merge": "^2.5.2",
      "tailwindcss-animate": "^1.0.7",
      "class-variance-authority": "^0.7.0",
      "clsx": "^2.1.1",
      "lucide-react": "^0.462.0",
      "@radix-ui/react-accordion": "^1.2.1",
      "@radix-ui/react-alert-dialog": "^1.1.2",
      "@radix-ui/react-avatar": "^1.1.1",
      "@radix-ui/react-checkbox": "^1.1.2",
      "@radix-ui/react-dialog": "^1.1.2",
      "@radix-ui/react-dropdown-menu": "^2.1.2",
      "@radix-ui/react-label": "^2.1.0",
      "@radix-ui/react-popover": "^1.1.2",
      "@radix-ui/react-progress": "^1.1.0",
      "@radix-ui/react-radio-group": "^1.2.1",
      "@radix-ui/react-select": "^2.1.2",
      "@radix-ui/react-separator": "^1.1.0",
      "@radix-ui/react-slider": "^1.2.1",
      "@radix-ui/react-slot": "^1.1.0",
      "@radix-ui/react-switch": "^1.1.1",
      "@radix-ui/react-tabs": "^1.1.1",
      "@radix-ui/react-toast": "^1.2.2",
      "@radix-ui/react-tooltip": "^1.1.3",
      "next-themes": "^0.3.0",
      "sonner": "^1.5.0",
      "react-hook-form": "^7.53.0",
      "@hookform/resolvers": "^3.9.0",
      "zod": "^3.23.8",
      "@tanstack/react-query": "^5.56.2",
      "date-fns": "^3.6.0",
      "recharts": "^2.12.7",
    }
  };

  writeFileSync(join(BASE_MODULES_DIR, "package.json"), JSON.stringify(basePkg, null, 2));

  const result = spawnSync("npm", ["install", "--prefer-offline"], {
    cwd: BASE_MODULES_DIR,
    stdio: "inherit",
    timeout: 300000,
  });

  if (result.status !== 0) {
    console.error("[Setup] Base install failed!");
  } else {
    console.log("[Setup] ✅ Base node_modules ready.");
  }
}

setupBaseModules();

// ─── Queue ────────────────────────────────────────────────────────────────────
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
    processQueue();
  }
}

function enqueue(projectId, files) {
  return new Promise((resolve, reject) => {
    queue.push({ projectId, files, resolve, reject });
    processQueue();
  });
}

// ─── MIME ─────────────────────────────────────────────────────────────────────
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

// ─── Build ────────────────────────────────────────────────────────────────────
async function buildProject(projectId, files) {
  const tmpDir = `/tmp/build-${randomUUID()}`;

  try {
    // 1. Write project files
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content, "utf8");
    }

    // 2. Pre-installed node_modules copy করো — npm install না করে
    console.log(`[Build] Copying base node_modules for ${projectId}...`);
    cpSync(
      join(BASE_MODULES_DIR, "node_modules"),
      join(tmpDir, "node_modules"),
      { recursive: true }
    );

    // 3. Vite build
    console.log(`[Build] Building ${projectId}...`);
    execSync("./node_modules/.bin/vite build", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 120000,
      env: { ...process.env, NODE_ENV: "production" },
    });

    // 4. Upload dist/ to B2
    const distDir = join(tmpDir, "dist");
    const prefix = `previews/${projectId}`;
    await uploadDir(distDir, distDir, prefix);

    const previewUrl = `${R2_PUBLIC_URL}/previews/${projectId}/index.html`;
    console.log(`[Build] ✅ Done: ${previewUrl}`);
    return previewUrl;

  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────
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
app.get("/health", (req, res) => {
  res.json({ ok: true, queue: queue.length, building: isBuilding });
});

app.post("/build", async (req, res) => {
  const { projectId, files, secret } = req.body;

  if (secret !== process.env.BUILD_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!projectId || !files?.length) {
    return res.status(400).json({ error: "projectId and files required" });
  }

  try {
    const url = await enqueue(projectId, files);
    res.json({ success: true, url });
  } catch (e) {
    console.error("[Build] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/queue", (req, res) => {
  res.json({ queue: queue.length, building: isBuilding });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Server] Build server running on port ${PORT}`);
});
