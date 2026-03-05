import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../plugin-api.js";

type Dict = Record<string, unknown>;

/**
 * Register a motion verification tool for post-action checks.
 * Compares two ros2_lidar_scene snapshots and scores whether motion likely succeeded.
 */
export function registerVerifyMotionTool(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "ros2_verify_motion",
    label: "ROS2 Verify Motion",
    description:
      "Verify whether a movement action likely succeeded by comparing pre/post lidar_scene snapshots.",
    parameters: Type.Object({
      before: Type.Record(Type.String(), Type.Unknown(), {
        description: "Scene snapshot before execution (output.details from ros2_lidar_scene)",
      }),
      after: Type.Record(Type.String(), Type.Unknown(), {
        description: "Scene snapshot after execution (output.details from ros2_lidar_scene)",
      }),
      expected: Type.Optional(
        Type.Union([
          Type.Literal("forward"),
          Type.Literal("turn_left"),
          Type.Literal("turn_right"),
          Type.Literal("stop"),
        ]),
      ),
      minLinearDelta: Type.Optional(Type.Number({ description: "Minimum expected translation in meters (default: 0.05)" })),
      minYawDeltaDeg: Type.Optional(Type.Number({ description: "Minimum expected yaw change in degrees (default: 8)" })),
    }),

    async execute(_toolCallId, params) {
      const before = params["before"] as Dict;
      const after = params["after"] as Dict;
      const expected = (params["expected"] as string | undefined) ?? "forward";
      const minLinearDelta = (params["minLinearDelta"] as number | undefined) ?? 0.05;
      const minYawDeltaDeg = (params["minYawDeltaDeg"] as number | undefined) ?? 8;

      const bPose = extractPose(before);
      const aPose = extractPose(after);
      const bFront = extractFront(before);
      const aFront = extractFront(after);

      const dx = safeSub(aPose.x, bPose.x);
      const dy = safeSub(aPose.y, bPose.y);
      const traveled = dx === null || dy === null ? null : Math.sqrt(dx * dx + dy * dy);
      const yawDeltaDeg = toDegDelta(aPose.yaw, bPose.yaw);
      const frontDelta = safeSub(aFront, bFront);

      const checks: string[] = [];
      let passed = false;

      if (expected === "forward") {
        const moved = traveled !== null && traveled >= minLinearDelta;
        const notWorse = frontDelta === null || frontDelta > -0.2;
        passed = moved && notWorse;
        if (!moved) checks.push(`translation too small: ${fmt(traveled)}m < ${minLinearDelta}m`);
        if (!notWorse) checks.push(`front clearance worsened: delta ${fmt(frontDelta)}m`);
      } else if (expected === "turn_left") {
        const turned = yawDeltaDeg !== null && yawDeltaDeg >= minYawDeltaDeg;
        passed = turned;
        if (!turned) checks.push(`left turn too small: ${fmt(yawDeltaDeg)}deg < ${minYawDeltaDeg}deg`);
      } else if (expected === "turn_right") {
        const turned = yawDeltaDeg !== null && yawDeltaDeg <= -minYawDeltaDeg;
        passed = turned;
        if (!turned) checks.push(`right turn too small: ${fmt(yawDeltaDeg)}deg > -${minYawDeltaDeg}deg`);
      } else if (expected === "stop") {
        const lowSpeed = Math.abs(aPose.linearSpeed ?? 0) < 0.02 && Math.abs(aPose.angularSpeed ?? 0) < 0.05;
        passed = lowSpeed;
        if (!lowSpeed) checks.push("robot still moving above stop threshold");
      }

      const confidence = scoreConfidence(passed, checks.length);
      const result = {
        success: true,
        expected,
        verdict: passed ? "pass" : "fail",
        confidence,
        metrics: {
          traveledMeters: traveled,
          yawDeltaDeg,
          frontDeltaMeters: frontDelta,
          beforeFrontMeters: bFront,
          afterFrontMeters: aFront,
        },
        checks,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

function extractPose(scene: Dict): {
  x: number | null;
  y: number | null;
  yaw: number | null;
  linearSpeed: number | null;
  angularSpeed: number | null;
} {
  const pose = asDict(scene["pose"]);
  return {
    x: num(pose?.["x"]),
    y: num(pose?.["y"]),
    yaw: num(pose?.["yaw"]),
    linearSpeed: num(pose?.["linearSpeed"]),
    angularSpeed: num(pose?.["angularSpeed"]),
  };
}

function extractFront(scene: Dict): number | null {
  const scan = asDict(scene["scan"]);
  const sectors = asDict(scan?.["sectors"]);
  return num(sectors?.["front"]);
}

function toDegDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const d = wrapRad(a - b);
  return (d * 180) / Math.PI;
}

function wrapRad(rad: number): number {
  let out = rad;
  while (out > Math.PI) out -= 2 * Math.PI;
  while (out <= -Math.PI) out += 2 * Math.PI;
  return out;
}

function safeSub(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function scoreConfidence(passed: boolean, issueCount: number): number {
  if (passed) return issueCount === 0 ? 0.95 : 0.8;
  return issueCount >= 2 ? 0.75 : 0.6;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asDict(v: unknown): Dict | null {
  return v && typeof v === "object" ? (v as Dict) : null;
}

function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "null";
  return v.toFixed(3);
}
