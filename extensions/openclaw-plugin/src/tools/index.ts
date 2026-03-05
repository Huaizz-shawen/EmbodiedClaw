import type { OpenClawPluginApi } from "../plugin-api.js";
import { registerPublishTool } from "./ros2-publish.js";
import { registerSubscribeTool } from "./ros2-subscribe.js";
import { registerServiceTool } from "./ros2-service.js";
import { registerActionTool } from "./ros2-action.js";
import { registerParamTools } from "./ros2-param.js";
import { registerIntrospectTool } from "./ros2-introspect.js";
import { registerCameraTool } from "./ros2-camera.js";
import { registerLidarSceneTool } from "./lidar-scene.js";
import { registerVerifyMotionTool } from "./ros2-verify-motion.js";

/**
 * Register all ROS2 tools with the OpenClaw AI agent.
 */
export function registerTools(api: OpenClawPluginApi): void {
  registerPublishTool(api);
  registerSubscribeTool(api);
  registerServiceTool(api);
  registerActionTool(api);
  registerParamTools(api);
  registerIntrospectTool(api);
  registerCameraTool(api);
  registerLidarSceneTool(api);
  registerVerifyMotionTool(api);
}
