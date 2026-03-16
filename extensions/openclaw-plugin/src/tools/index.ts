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
import { recordEpisode } from "../learning/episode-store.js";
import { getTransportMode } from "../service.js";
import type { ToolResult } from "../plugin-api.js";

/**
 * Register all ROS2 tools with the OpenClaw AI agent.
 */
export function registerTools(api: OpenClawPluginApi): void {
  const tracedApi: OpenClawPluginApi = {
    ...api,
    registerTool(tool, opts) {
      const wrappedTool = {
        ...tool,
        async execute(
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<ToolResult> {
          const started = Date.now();
          try {
            const result = await tool.execute(toolCallId, params, signal);
            await recordEpisode({
              ts: new Date().toISOString(),
              tool: tool.name,
              status: "success",
              durationMs: Date.now() - started,
              transportMode: getTransportMode(),
              params,
              result: result.details,
            });
            return result;
          } catch (err) {
            await recordEpisode({
              ts: new Date().toISOString(),
              tool: tool.name,
              status: "error",
              durationMs: Date.now() - started,
              transportMode: getTransportMode(),
              params,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
      };
      api.registerTool(wrappedTool, opts);
    },
  };

  registerPublishTool(tracedApi);
  registerSubscribeTool(tracedApi);
  registerServiceTool(tracedApi);
  registerActionTool(tracedApi);
  registerParamTools(tracedApi);
  registerIntrospectTool(tracedApi);
  registerCameraTool(tracedApi);
  registerLidarSceneTool(tracedApi);
  registerVerifyMotionTool(tracedApi);
}
