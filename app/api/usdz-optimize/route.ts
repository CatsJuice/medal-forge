import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const USDZ_MIME_TYPE = "model/vnd.usdz+zip";

export async function POST(request: Request) {
  const sourceBytes = new Uint8Array(await request.arrayBuffer());

  try {
    await assertUsdToolsAvailable();

    const optimizedBytes = await convertUsdGeometryToBinary(sourceBytes);

    if (optimizedBytes.byteLength >= sourceBytes.byteLength) {
      return createUsdzResponse(sourceBytes, "kept-original");
    }

    return createUsdzResponse(optimizedBytes, "optimized-usdc");
  } catch {
    return createUsdzResponse(sourceBytes, "fallback-original");
  }
}

async function assertUsdToolsAvailable() {
  await Promise.all([
    execFileAsync("usdcat", ["--version"]),
    execFileAsync("usdzip", ["--version"]),
  ]);
}

async function convertUsdGeometryToBinary(sourceBytes: Uint8Array) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "medal-usdz-"));

  try {
    const zip = await JSZip.loadAsync(sourceBytes);
    const geometryFiles: string[] = [];
    const packageFiles: string[] = [];

    for (const [filename, entry] of Object.entries(zip.files)) {
      if (entry.dir) {
        continue;
      }

      const bytes = await entry.async("uint8array");
      const filePath = path.join(workDir, filename);

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);

      if (filename.startsWith("geometries/") && filename.endsWith(".usda")) {
        geometryFiles.push(filename);
      } else {
        packageFiles.push(filename);
      }
    }

    for (const filename of geometryFiles) {
      const sourcePath = path.join(workDir, filename);
      const targetPath = sourcePath.replace(/\.usda$/u, ".usdc");

      await execFileAsync("usdcat", [sourcePath, "-o", targetPath]);
      packageFiles.push(filename.replace(/\.usda$/u, ".usdc"));
    }

    const modelPath = path.join(workDir, "model.usda");
    const modelEntry = zip.file("model.usda");

    if (modelEntry) {
      const modelText = await modelEntry.async("text");
      await writeFile(
        modelPath,
        modelText.replace(
          /@\.\/geometries\/([^@]+)\.usda@/gu,
          "@./geometries/$1.usdc@",
        ),
      );
    }

    const outputPath = path.join(workDir, "optimized.usdz");
    const inputFiles = [
      "model.usda",
      ...packageFiles
        .filter((filename) => filename !== "model.usda")
        .sort((left, right) => left.localeCompare(right)),
    ];

    await execFileAsync("usdzip", [outputPath, ...inputFiles], {
      cwd: workDir,
    });

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

function createUsdzResponse(bytes: Uint8Array, optimizer: string) {
  return new Response(getArrayBuffer(bytes), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": USDZ_MIME_TYPE,
      "X-Medal-Forge-USDZ-Optimizer": optimizer,
    },
  });
}

function getArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
