import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../plugin-api.js";
import { getTransport } from "../service.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";

type Dict = Record<string, unknown>;
type SnapshotKind = "compressed" | "raw";

/**
 * Register the ros2_camera_snapshot tool with the AI agent.
 * Grabs a single frame from a camera topic (CompressedImage or raw Image).
 */
export function registerCameraTool(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "ros2_camera_snapshot",
    label: "ROS2 Camera Snapshot",
    description:
      "Capture a single image from a ROS2 camera topic. Supports both CompressedImage and raw Image. " +
      "Use this when the user asks what the robot sees or requests a photo.",
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({
          description:
            "Camera topic. If omitted, tries '/camera/image_raw/compressed' then '/camera/image_raw'",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description:
            "Message type override (sensor_msgs/msg/CompressedImage or sensor_msgs/msg/Image)",
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 10000)" })),
      saveToFile: Type.Optional(
        Type.Boolean({
          description:
            "Whether to save the captured image to local workspace (default: false)",
        }),
      ),
      savePath: Type.Optional(
        Type.String({
          description:
            "Optional absolute file path override. If omitted, uses workspace snapshot directory.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const topic = params["topic"] as string | undefined;
      const msgType = params["type"] as string | undefined;
      const timeout = (params["timeout"] as number | undefined) ?? 10000;
      const saveToFile = (params["saveToFile"] as boolean | undefined) ?? false;
      const savePath = params["savePath"] as string | undefined;

      const transport = getTransport();
      const candidates = buildCandidates(topic, msgType);
      const errors: string[] = [];

      for (const c of candidates) {
        try {
          const msg = await subscribeOnce(transport, c.topic, c.type, timeout);
          const image = decodeSnapshot(msg, c.kind);
          const result: {
            success: boolean;
            topic: string;
            type: string;
            format: string;
            mimeType: string;
            width: number | null;
            height: number | null;
            encoding: string | null;
            dataBytes: number;
            savedPath?: string;
          } = {
            success: true,
            topic: c.topic,
            type: c.type,
            format: image.format,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            encoding: image.encoding,
            dataBytes: estimateBase64Bytes(image.data),
          };

          if (saveToFile) {
            result.savedPath = await persistSnapshot(
              image.data,
              image.format,
              savePath,
              c.topic,
            );
          }

          const publicSummary = {
            success: true,
            topic: result.topic,
            format: result.format,
            width: result.width,
            height: result.height,
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(publicSummary),
              },
              { type: "image", data: image.data, mimeType: image.mimeType },
            ],
            details: result,
          };
        } catch (err) {
          errors.push(`${c.topic} (${c.type}): ${String(err)}`);
        }
      }

      throw new Error(
        `Failed to capture camera snapshot. Tried: ${candidates
          .map((c) => `${c.topic} (${c.type})`)
          .join(", ")}. Errors: ${errors.join(" | ")}`,
      );
    },
  });
}

function buildCandidates(
  topic: string | undefined,
  type: string | undefined,
): Array<{ topic: string; type: string; kind: SnapshotKind }> {
  if (topic && type) {
    return [
      {
        topic,
        type,
        kind: type === "sensor_msgs/msg/Image" ? "raw" : "compressed",
      },
    ];
  }

  if (topic) {
    return [
      { topic, type: "sensor_msgs/msg/CompressedImage", kind: "compressed" },
      { topic, type: "sensor_msgs/msg/Image", kind: "raw" },
    ];
  }

  return [
    {
      topic: "/camera/image_raw/compressed",
      type: "sensor_msgs/msg/CompressedImage",
      kind: "compressed",
    },
    {
      topic: "/camera/image_raw",
      type: "sensor_msgs/msg/Image",
      kind: "raw",
    },
  ];
}

async function subscribeOnce(
  transport: ReturnType<typeof getTransport>,
  topic: string,
  type: string,
  timeout: number,
): Promise<Dict> {
  return new Promise<Dict>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = transport.subscribe({ topic, type }, (msg: Dict) => {
      if (timer) clearTimeout(timer);
      subscription.unsubscribe();
      resolve(msg);
    });

    timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error(`Timeout waiting for camera frame on ${topic}`));
    }, timeout);
  });
}

function decodeSnapshot(
  msg: Dict,
  preferred: SnapshotKind,
): {
  data: string;
  mimeType: string;
  format: string;
  width: number | null;
  height: number | null;
  encoding: string | null;
} {
  // Raw Image messages carry geometry fields. Prefer raw path when present.
  const looksRaw =
    typeof msg["width"] === "number" &&
    typeof msg["height"] === "number" &&
    typeof msg["encoding"] === "string";

  if (looksRaw) {
    return decodeRaw(msg);
  }

  // If message looks like CompressedImage, decode as compressed.
  if (typeof msg["format"] === "string" || msg["data"] !== undefined) {
    return decodeCompressed(msg);
  }
  if (preferred === "raw") {
    return decodeRaw(msg);
  }
  // Fallback path in case type metadata was wrong but message is raw.
  return decodeRaw(msg);
}

function decodeCompressed(msg: Dict): {
  data: string;
  mimeType: string;
  format: string;
  width: null;
  height: null;
  encoding: null;
} {
  const format = (msg["format"] as string | undefined)?.toLowerCase() ?? "jpeg";
  const data = extractDataBase64(msg["data"]);
  if (!data) throw new Error("CompressedImage has empty data");
  return {
    data,
    mimeType: formatToMime(format),
    format,
    width: null,
    height: null,
    encoding: null,
  };
}

function decodeRaw(msg: Dict): {
  data: string;
  mimeType: string;
  format: string;
  width: number;
  height: number;
  encoding: string;
} {
  const width = toInt(msg["width"]);
  const height = toInt(msg["height"]);
  const step = toInt(msg["step"]);
  const encoding = String(msg["encoding"] ?? "rgb8").toLowerCase();
  const bytes = extractDataBytes(msg["data"]);

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid raw image size: ${width}x${height}`);
  }
  if (!bytes || bytes.length === 0) {
    throw new Error("Raw Image has empty data");
  }

  const png = rawImageToPng(width, height, step, encoding, bytes);
  return {
    data: Buffer.from(png).toString("base64"),
    mimeType: "image/png",
    format: "png",
    width,
    height,
    encoding,
  };
}

function rawImageToPng(
  width: number,
  height: number,
  step: number,
  encoding: string,
  data: Uint8Array,
): Uint8Array {
  const channels = channelsForEncoding(encoding);
  const srcRowStride = step > 0 ? step : width * channels;
  const raw = new Uint8Array(height * (1 + width * 3));

  let outOffset = 0;
  for (let y = 0; y < height; y += 1) {
    // PNG filter method 0 (None) per row.
    raw[outOffset++] = 0;
    const srcRow = y * srcRowStride;
    for (let x = 0; x < width; x += 1) {
      const src = srcRow + x * channels;
      const [r, g, b] = readPixel(data, src, encoding);
      raw[outOffset++] = r;
      raw[outOffset++] = g;
      raw[outOffset++] = b;
    }
  }

  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor RGB
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method

  const idatData = new Uint8Array(deflateSync(raw));

  const ihdrChunk = pngChunk("IHDR", ihdrData);
  const idatChunk = pngChunk("IDAT", idatData);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));

  return concatUint8(signature, ihdrChunk, idatChunk, iendChunk);
}

function readPixel(data: Uint8Array, idx: number, encoding: string): [number, number, number] {
  if (encoding === "rgb8") {
    return [data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0];
  }
  if (encoding === "bgr8") {
    return [data[idx + 2] ?? 0, data[idx + 1] ?? 0, data[idx] ?? 0];
  }
  if (encoding === "rgba8") {
    return [data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0];
  }
  if (encoding === "bgra8") {
    return [data[idx + 2] ?? 0, data[idx + 1] ?? 0, data[idx] ?? 0];
  }
  // mono8 fallback
  const v = data[idx] ?? 0;
  return [v, v, v];
}

function channelsForEncoding(encoding: string): number {
  if (encoding === "rgb8" || encoding === "bgr8") return 3;
  if (encoding === "rgba8" || encoding === "bgra8") return 4;
  return 1;
}

function extractDataBase64(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.from(data as number[]).toString("base64");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  return "";
}

function extractDataBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) {
    return Uint8Array.from(
      data.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)),
    );
  }
  if (typeof data === "string") return Uint8Array.from(Buffer.from(data, "base64"));
  return new Uint8Array(0);
}

function formatToMime(format: string): string {
  if (format.includes("jpeg") || format.includes("jpg")) return "image/jpeg";
  if (format.includes("png")) return "image/png";
  if (format.includes("webp")) return "image/webp";
  return "image/jpeg";
}

function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc >>> 0, false);
  return out;
}

function concatUint8(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

async function persistSnapshot(
  base64: string,
  format: string,
  savePath: string | undefined,
  topic: string,
): Promise<string> {
  const explicitPath = savePath?.trim();
  if (explicitPath) {
    const parent = explicitPath.slice(0, Math.max(0, explicitPath.lastIndexOf("/")));
    if (parent) await mkdir(parent, { recursive: true });
    await writeFile(explicitPath, Buffer.from(base64, "base64"));
    return explicitPath;
  }

  const workspace = process.env["OPENCLAW_WORKSPACE"] ?? "/home/node/.openclaw/workspace";
  const dir = join(workspace, "rosclaw_snapshots");
  await mkdir(dir, { recursive: true });

  const ext = formatToExt(format);
  const topicSlug = basename(topic).replace(/[^a-zA-Z0-9_-]/g, "_") || "camera";
  const filePath = join(dir, `${topicSlug}_${Date.now()}.${ext}`);
  await writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

function formatToExt(format: string): string {
  const f = format.toLowerCase();
  if (f.includes("jpeg") || f.includes("jpg")) return "jpg";
  if (f.includes("png")) return "png";
  if (f.includes("webp")) return "webp";
  if (f.includes("bmp")) return "bmp";
  return "jpg";
}
