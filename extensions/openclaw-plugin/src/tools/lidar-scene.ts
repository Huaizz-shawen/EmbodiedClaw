import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../plugin-api.js";
import { getTransport } from "../service.js";

type Dict = Record<string, unknown>;

interface OdomPose {
  x: number | null;
  y: number | null;
  yaw: number | null;
  linearSpeed: number | null;
  angularSpeed: number | null;
}

interface LidarSummary {
  sampleCount: number;
  validCount: number;
  minDistance: number | null;
  sectors: {
    front: number | null;
    left: number | null;
    right: number | null;
    rear: number | null;
  };
  frontBlocked: boolean;
  caution: boolean;
  recommendedHeadingDeg: number | null;
  freeWindowDeg: [number, number] | null;
}

/**
 * Register a structured LIDAR scene snapshot tool.
 * Designed for MVP "Sense" + "Post-check" loops when camera topics are unavailable.
 */
export function registerLidarSceneTool(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "ros2_lidar_scene",
    label: "ROS2 Lidar Scene",
    description:
      "Build a structured local scene state from LaserScan + Odometry. " +
      "Use this before planning and after execution to validate motion outcomes.",
    parameters: Type.Object({
      scanTopic: Type.Optional(Type.String({ description: "LaserScan topic (default: '/scan')" })),
      odomTopic: Type.Optional(Type.String({ description: "Odometry topic (default: '/odom')" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 5000)" })),
      safeDistance: Type.Optional(Type.Number({ description: "Distance threshold for 'blocked' in meters (default: 0.6)" })),
      cautionDistance: Type.Optional(Type.Number({ description: "Distance threshold for caution in meters (default: 1.0)" })),
    }),

    async execute(_toolCallId, params) {
      const scanTopic = (params["scanTopic"] as string | undefined) ?? "/scan";
      const odomTopic = (params["odomTopic"] as string | undefined) ?? "/odom";
      const timeout = (params["timeout"] as number | undefined) ?? 5000;
      const safeDistance = (params["safeDistance"] as number | undefined) ?? 0.6;
      const cautionDistance = (params["cautionDistance"] as number | undefined) ?? 1.0;

      const transport = getTransport();
      const [scanMsg, odomMsg] = await Promise.all([
        subscribeOnce(transport, scanTopic, "sensor_msgs/msg/LaserScan", timeout),
        subscribeOnce(transport, odomTopic, "nav_msgs/msg/Odometry", timeout),
      ]);

      const scan = summarizeScan(scanMsg, safeDistance, cautionDistance);
      const pose = summarizeOdom(odomMsg);
      const timestampSec = extractStampSec(scanMsg["header"] as Dict | undefined);

      const result = {
        success: true,
        scanTopic,
        odomTopic,
        timestampSec,
        pose,
        scan,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

async function subscribeOnce(
  transport: ReturnType<typeof getTransport>,
  topic: string,
  type: string,
  timeout: number,
): Promise<Dict> {
  return new Promise<Dict>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = transport.subscribe(
      { topic, type },
      (msg: Dict) => {
        if (timer) clearTimeout(timer);
        sub.unsubscribe();
        resolve(msg);
      },
    );

    timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Timeout waiting for message on ${topic}`));
    }, timeout);
  });
}

function summarizeScan(scanMsg: Dict, safeDistance: number, cautionDistance: number): LidarSummary {
  const rangesRaw = scanMsg["ranges"];
  const ranges = Array.isArray(rangesRaw) ? rangesRaw : [];
  const angleMin = num(scanMsg["angle_min"]) ?? 0;
  const angleInc = num(scanMsg["angle_increment"]) ?? ((2 * Math.PI) / 360);
  const rangeMin = num(scanMsg["range_min"]) ?? 0;
  const rangeMax = num(scanMsg["range_max"]) ?? Number.POSITIVE_INFINITY;

  const normalized = ranges.map((v) => normalizeRange(v, rangeMin, rangeMax));
  const valid = normalized.filter((v): v is number => v !== null);
  const minDistance = valid.length > 0 ? Math.min(...valid) : null;

  const front = sectorMin(normalized, angleMin, angleInc, -30, 30);
  const left = sectorMin(normalized, angleMin, angleInc, 60, 120);
  const right = sectorMin(normalized, angleMin, angleInc, -120, -60);
  const rear = sectorMin(normalized, angleMin, angleInc, 150, -150);

  const bestWindow = findBestHeadingWindow(normalized, angleMin, angleInc, cautionDistance);
  const frontBlocked = front !== null && front < safeDistance;
  const caution = front !== null && front < cautionDistance;

  return {
    sampleCount: ranges.length,
    validCount: valid.length,
    minDistance,
    sectors: { front, left, right, rear },
    frontBlocked,
    caution,
    recommendedHeadingDeg: bestWindow?.headingDeg ?? null,
    freeWindowDeg: bestWindow?.windowDeg ?? null,
  };
}

function summarizeOdom(odomMsg: Dict): OdomPose {
  const pose = asDict(odomMsg["pose"]);
  const poseInner = asDict(pose?.["pose"]);
  const position = asDict(poseInner?.["position"]);
  const orientation = asDict(poseInner?.["orientation"]);
  const twist = asDict(odomMsg["twist"]);
  const twistInner = asDict(twist?.["twist"]);
  const linear = asDict(twistInner?.["linear"]);
  const angular = asDict(twistInner?.["angular"]);

  return {
    x: num(position?.["x"]),
    y: num(position?.["y"]),
    yaw: quatToYawRad(
      num(orientation?.["x"]),
      num(orientation?.["y"]),
      num(orientation?.["z"]),
      num(orientation?.["w"]),
    ),
    linearSpeed: num(linear?.["x"]),
    angularSpeed: num(angular?.["z"]),
  };
}

function findBestHeadingWindow(
  ranges: Array<number | null>,
  angleMin: number,
  angleInc: number,
  threshold: number,
): { headingDeg: number; windowDeg: [number, number] } | null {
  const n = ranges.length;
  if (n === 0) return null;

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < n; i += 1) {
    const isFree = ranges[i] !== null && (ranges[i] as number) >= threshold;
    if (isFree) {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestStart < 0 || bestLen === 0) return null;

  const centerIdx = bestStart + Math.floor(bestLen / 2);
  const headingDeg = wrapTo180(radToDeg(angleAt(centerIdx, angleMin, angleInc)));
  const startDeg = wrapTo180(radToDeg(angleAt(bestStart, angleMin, angleInc)));
  const endDeg = wrapTo180(radToDeg(angleAt(bestStart + bestLen - 1, angleMin, angleInc)));

  return {
    headingDeg,
    windowDeg: [startDeg, endDeg],
  };
}

function sectorMin(
  ranges: Array<number | null>,
  angleMin: number,
  angleInc: number,
  startDeg: number,
  endDeg: number,
): number | null {
  const picks: number[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const aDeg = wrapTo180(radToDeg(angleAt(i, angleMin, angleInc)));
    const inSector = angleInSector(aDeg, startDeg, endDeg);
    const d = ranges[i];
    if (inSector && d !== null) picks.push(d);
  }
  return picks.length > 0 ? Math.min(...picks) : null;
}

function angleInSector(angleDeg: number, startDeg: number, endDeg: number): boolean {
  const a = wrapTo180(angleDeg);
  const s = wrapTo180(startDeg);
  const e = wrapTo180(endDeg);
  if (s <= e) return a >= s && a <= e;
  return a >= s || a <= e;
}

function angleAt(index: number, angleMin: number, angleInc: number): number {
  return angleMin + index * angleInc;
}

function normalizeRange(v: unknown, min: number, max: number): number | null {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function extractStampSec(header: Dict | undefined): number | null {
  if (!header) return null;
  const stamp = asDict(header["stamp"]);
  if (!stamp) return null;
  const sec = num(stamp["sec"]);
  const nanosec = num(stamp["nanosec"]);
  if (sec === null) return null;
  return nanosec === null ? sec : sec + nanosec / 1e9;
}

function quatToYawRad(
  x: number | null,
  y: number | null,
  z: number | null,
  w: number | null,
): number | null {
  if (x === null || y === null || z === null || w === null) return null;
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  return Math.atan2(siny, cosy);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asDict(v: unknown): Dict | null {
  return v && typeof v === "object" ? (v as Dict) : null;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function wrapTo180(deg: number): number {
  let out = deg;
  while (out > 180) out -= 360;
  while (out <= -180) out += 360;
  return out;
}
