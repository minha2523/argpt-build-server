import express from "express";
import cors from "cors";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync, createWriteStream, createReadStream } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { createUnzip } from "zlib";
import { Extract } from "unzipper";

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

// ─── Base node_modules setup ──────────────────────────────────────────────────
const BASE_MODULES_DIR = "/tmp/base-node-modules";
let baseModulesReady = false;

async function setupBaseModules() {
  if (existsSync(join(BASE_MODULES_DIR, "node_modules"))) {
    console.log("[Setup] Base node_modules already ready.");
    baseModulesReady = true;
    return;
  }

  console.log("[Setup] Downloading node_modules.zip from B2...");
  mkdirSync(BASE_MODULES_DIR, { recursive: true });

  try {
    // B2 থেকে zip download করো
    const res = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: "node_modules.zip",
    }));

    const zipPath = join(BASE_MODULES_DIR, "node_modules.zip");
    const writeStream = createWriteStream(zipPath);
    await pipeline(res.Body, writeStream);
    console.log("[Setup] Download complete. Extracting...");

    // Extract করো
    await new Promise((resolve, reject) => {
      const extract = Extract({ path: BASE_MODULES_DIR });
      extract.on("close", resolve);
      extract.on("error", reject);
      createReadStream(zipPath).pipe(extract);
    });

    // zip file delete করো — space বাঁচাও
    rmSync(zipPath);

    console.log("[Setup] ✅ Base node_modules ready!");
    baseModulesReady = true;
  } catch (e) {
    console.error("[Setup] Failed:", e.message);
  }
}

// Server start এ setup করো
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
  // Base modules ready না হলে wait করো
  let waited = 0;
  while (!baseModulesReady && waited < 120000) {
    await new Promise(r => setTimeout(r, 2000));
    waited += 2000;
  }

  if (!baseModulesReady) throw new Error("Base modules not ready");

  const tmpDir = `/tmp/build-${randomUUID()}`;

  try {
    // 1. Write project files
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content, "utf8");
    }

    // 2. Base node_modules symlink করো — copy না, pointer মাত্র → fast!
    console.log(`[Build] Symlinking node_modules for ${projectId}...`);
    execSync(`ln -s ${join(BASE_MODULES_DIR, "node_modules")} ${join(tmpDir, "node_modules")}`);

    // 3. Extra packages install করো — শুধু dependencies, devDependencies skip
    // (eslint, vitest, testing-library — এগুলো preview build এ লাগে না)
    const SKIP_PACKAGES = [
      "eslint", "@eslint/js", "vitest", "jsdom", "@testing-library/react",
      "@testing-library/jest-dom", "eslint-plugin-react-hooks",
      "eslint-plugin-react-refresh", "globals", "typescript-eslint",
    ];

    const pkgJsonPath = join(tmpDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      // শুধু dependencies — devDependencies না
      const deps = pkgJson.dependencies || {};
      const extraPkgs = Object.keys(deps).filter(
        pkg => !SKIP_PACKAGES.includes(pkg) && !existsSync(join(tmpDir, "node_modules", pkg))
      );

      if (extraPkgs.length > 0) {
        console.log(`[Build] Installing extra: ${extraPkgs.join(", ")}`);
        const installArgs = extraPkgs.map(p => `${p}@${deps[p]}`).join(" ");
        execSync(`npm install ${installArgs} --prefer-offline`, {
          cwd: tmpDir,
          stdio: "pipe",
          timeout: 60000,
        });
      }
    }

    // 4. Vite build
    console.log(`[Build] Building ${projectId}...`);
    execSync("./node_modules/.bin/vite build", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 120000,
      env: { ...process.env, NODE_ENV: "production" },
    });

    // 5. Upload dist/ to B2
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
  res.json({ ok: true, queue: queue.length, building: isBuilding, baseModulesReady });
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
