import type { OpenClawPluginApi } from "../plugin-api.js";
import type { RosClawConfig } from "../config.js";
import type { TopicInfo, ServiceInfo, ActionInfo } from "../transport/types.js";
import { getTransport } from "../service.js";

/** Cached discovery results with TTL. */
interface DiscoveryCache {
  topics: TopicInfo[];
  services: ServiceInfo[];
  actions: ActionInfo[];
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 60s
let cache: DiscoveryCache | null = null;

/** Clear the discovery cache so the next agent start re-discovers capabilities. */
export function clearDiscoveryCache(): void {
  cache = null;
}

/**
 * Register the before_agent_start hook to inject robot capabilities
 * into the AI agent's system context.
 */
export function registerRobotContext(api: OpenClawPluginApi, config: RosClawConfig): void {
  const robotName = config.robot.name;
  const robotNamespace = config.robot.namespace;

  // Reactive re-discovery: clear cache on transport reconnect
  try {
    const transport = getTransport();
    transport.onConnection((status: string) => {
      if (status === "connected") {
        cache = null; // Force re-discovery on next agent start
        api.logger.info("Transport reconnected — capability cache cleared");
      }
    });
  } catch {
    // Transport not initialized yet — will be set up by the service.
    // The onConnection handler will be registered when the hook fires.
  }

  api.on("before_agent_start", async (_event, _ctx) => {
    const capabilities = await discoverCapabilities(api, robotNamespace);
    const context = buildRobotContext(robotName, robotNamespace, capabilities);
    return { prependContext: context };
  });
}

/**
 * Discover live capabilities from the transport layer, with caching.
 * Falls back to empty lists if discovery fails.
 */
async function discoverCapabilities(
  api: OpenClawPluginApi,
  namespace: string,
): Promise<DiscoveryCache> {
  // Return cached results if still fresh
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache;
  }

  try {
    const transport = getTransport();

    const [topics, services, actions] = await Promise.all([
      transport.listTopics(),
      transport.listServices(),
      transport.listActions(),
    ]);

    // Filter by namespace if configured
    const filterByNs = (name: string) =>
      !namespace || name.startsWith(namespace);

    cache = {
      topics: topics.filter((t: TopicInfo) => filterByNs(t.name)),
      services: services.filter((s: ServiceInfo) => filterByNs(s.name)),
      actions: actions.filter((a: ActionInfo) => filterByNs(a.name)),
      timestamp: Date.now(),
    };

    api.logger.info(
      `Discovered ${cache.topics.length} topics, ${cache.services.length} services, ${cache.actions.length} actions`,
    );

    return cache;
  } catch (err) {
    api.logger.warn(`Capability discovery failed, using defaults: ${err}`);
    return {
      topics: [],
      services: [],
      actions: [],
      timestamp: 0,
    };
  }
}

/**
 * Build the robot context string that gets injected into the agent's system prompt.
 */
function buildRobotContext(
  name: string,
  namespace: string,
  capabilities: DiscoveryCache,
): string {
  const { topics, services, actions } = capabilities;

  // If discovery returned results, use them
  if (topics.length > 0 || services.length > 0 || actions.length > 0) {
    return buildDynamicContext(name, topics, services, actions);
  }

  // Fall back to hardcoded defaults if discovery failed
  return buildFallbackContext(name, namespace);
}

function buildDynamicContext(
  name: string,
  topics: TopicInfo[],
  services: ServiceInfo[],
  actions: ActionInfo[],
): string {
  let context = `## Robot: ${name}\n\n`;
  context += `You are connected to a ROS2 robot named "${name}". You can control it using the ros2_* tools.\n\n`;

  if (topics.length > 0) {
    context += "### Available Topics\n";
    for (const t of topics) {
      context += `- \`${t.name}\` (${t.type})\n`;
    }
    context += "\n";
  }

  if (services.length > 0) {
    context += "### Available Services\n";
    for (const s of services) {
      context += `- \`${s.name}\` (${s.type})\n`;
    }
    context += "\n";
  }

  if (actions.length > 0) {
    context += "### Available Actions\n";
    for (const a of actions) {
      context += `- \`${a.name}\` (${a.type})\n`;
    }
    context += "\n";
  }

  context += `### Safety Limits
- Maximum linear velocity: 1.0 m/s
- Maximum angular velocity: 1.5 rad/s
- All velocity commands are validated before execution

### Tips
- Use \`ros2_list_topics\` to discover all available topics
- Use \`ros2_subscribe_once\` to read the current value of any topic
- Use \`ros2_lidar_scene\` before planning and after execution for structured local scene state
- Use \`ros2_verify_motion\` to compare pre/post scene snapshots and verify motion success
- Use \`ros2_camera_snapshot\` to see what the robot sees
- The user can say /estop at any time to immediately stop the robot`;

  return context;
}

function buildFallbackContext(name: string, namespace: string): string {
  const prefix = namespace ? `${namespace}/` : "/";

  return `
## Robot: ${name}

You are connected to a ROS2 robot named "${name}". You can control it using the ros2_* tools.

### Available Topics
- \`${prefix}cmd_vel\` (geometry_msgs/msg/Twist) — Velocity commands
- \`${prefix}odom\` (nav_msgs/msg/Odometry) — Odometry data
- \`${prefix}scan\` (sensor_msgs/msg/LaserScan) — LIDAR scan
- \`${prefix}camera/image_raw/compressed\` (sensor_msgs/msg/CompressedImage) — Camera feed
- \`${prefix}battery_state\` (sensor_msgs/msg/BatteryState) — Battery status

### Safety Limits
- Maximum linear velocity: 1.0 m/s
- Maximum angular velocity: 1.5 rad/s
- All velocity commands are validated before execution

### Tips
- Use \`ros2_list_topics\` to discover all available topics
- Use \`ros2_subscribe_once\` to read the current value of any topic
- Use \`ros2_lidar_scene\` before planning and after execution for structured local scene state
- Use \`ros2_verify_motion\` to compare pre/post scene snapshots and verify motion success
- Use \`ros2_camera_snapshot\` to see what the robot sees
- The user can say /estop at any time to immediately stop the robot
`.trim();
}
