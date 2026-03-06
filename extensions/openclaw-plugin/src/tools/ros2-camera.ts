import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../plugin-api.js";
import { getTransport } from "../service.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
            "Whether to save the captured image to local workspace (default: true)",
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
      const saveToFile = (params["saveToFile"] as boolean | undefined) ?? true;
      const savePath = params["savePath"] as string | undefined;

      const transport = getTransport();
      const candidates = buildCandidates(topic, msgType);
      const errors: string[] = [];

      for (const c of candidates) {
        try {
          const msg = await subscribeOnce(transport, c.topic, c.type, timeout);
          const image = decodeSnapshot(msg, c.kind);
          const result = {
            success: true,
            topic: c.topic,
            type: c.type,
            format: image.format,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            encoding: image.encoding,
            data: image.data,
            savedPath: null as string | null,
          };

          if (saveToFile) {
            result.savedPath = await persistSnapshot(image.data, image.format, savePath, c.topic);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...result, data: "[base64 omitted]" }),
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

  const bmp = rawImageToBmp(width, height, step, encoding, bytes);
  return {
    data: Buffer.from(bmp).toString("base64"),
    mimeType: "image/bmp",
    format: "bmp",
    width,
    height,
    encoding,
  };
}

function rawImageToBmp(
  width: number,
  height: number,
  step: number,
  encoding: string,
  data: Uint8Array,
): Uint8Array {
  const channels = channelsForEncoding(encoding);
  const srcRowStride = step > 0 ? step : width * channels;
  const dstRowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = dstRowStride * height;
  const totalSize = 14 + 40 + pixelBytes;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  view.setUint32(2, totalSize, true);
  view.setUint32(10, 14 + 40, true);

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true); // DIB header size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // bottom-up bitmap
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bpp
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // 72 DPI
  view.setInt32(42, 2835, true);

  let dstOffset = 14 + 40;
  for (let y = height - 1; y >= 0; y -= 1) {
    const srcRow = y * srcRowStride;
    for (let x = 0; x < width; x += 1) {
      const src = srcRow + x * channels;
      const [r, g, b] = readPixel(data, src, encoding);
      out[dstOffset++] = b;
      out[dstOffset++] = g;
      out[dstOffset++] = r;
    }
    while ((dstOffset - (14 + 40)) % dstRowStride !== 0) {
      out[dstOffset++] = 0;
    }
  }

  return out;
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
