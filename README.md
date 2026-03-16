# RosClaw

**Natural language control of ROS2 robots through messaging apps, powered by AI agents.**

RosClaw connects [OpenClaw](https://github.com/openclaw) to [ROS2](https://docs.ros.org/) (the Robot Operating System) through an intelligent plugin layer. Send a message on Telegram, WhatsApp, Discord, or Slack — the robot moves. Connect to your own robot or "lease" any robot registered into our portal globally. Each robot registers their own profile with capabilitie.

Whethere it's a cute desk robot or a humanoid robot, all you have to do is install our OpenClaw extension and run our ROS2 packakge.

<p align="center">
  <a href="https://x.com/livinoffwater/status/2017172436119331133">
    <img src="assets/thumbnail-1.jpg" alt="RosClaw Demo Video" width="380" />
  </a>
  &nbsp;&nbsp;
  <a href="">
    <img src="assets/thumbnail-2.jpg" alt="RosClaw Demo" width="380" />
  </a>
  <br />
  <em>Click to watch the demos</em>
</p>

## How It Works

```
User (WhatsApp/Telegram/Discord/Slack)
        |
        v
OpenClaw Gateway (AI Agent + Tools + Memory)
        |
        v  RosClaw Plugin
rosbridge_server (WebSocket)
        |
        v  ROS2 DDS
Robots: Nav2, MoveIt2, cameras, sensors
```

1. A user sends a natural language message through any messaging app
2. OpenClaw's AI agent receives the message and uses ROS2 tools registered by the RosClaw plugin
3. The agent translates intent into ROS2 operations (topic publish, service call, action goal)
4. The robot acts, and the agent streams feedback back to the chat

## Project Structure

```
rosclaw/
├── packages/
│   └── rosbridge-client/         # @rosclaw/rosbridge-client — TypeScript rosbridge WebSocket client
├── extensions/
│   ├── openclaw-plugin/          # @rosclaw/openclaw-plugin — Core OpenClaw extension
│   └── openclaw-canvas/          # @rosclaw/openclaw-canvas — Real-time dashboard (Phase 3)
├── ros2_ws/src/
│   ├── rosclaw_discovery/        # ROS2 capability auto-discovery node
│   └── rosclaw_msgs/             # Custom ROS2 message/service definitions
├── docker/                       # Docker Compose stack
└── examples/                     # Demo projects
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for simulation)

### Install & Build

```bash
pnpm install
pnpm build
```

### Run the Demo Stack

```bash
cd docker
docker compose up
```

This starts ROS2 + rosbridge + Gazebo. Then configure your OpenClaw instance to use the RosClaw plugin with `ws://localhost:9090`.

### Try It

Send a message to your robot:
- **"Move forward 1 meter"** — publishes velocity to `/cmd_vel`
- **"Navigate to the kitchen"** — sends a Nav2 goal
- **"What do you see?"** — captures a camera frame
- **"Check the battery"** — reads `/battery_state`
- **`/estop`** — emergency stop (bypasses AI)

## Packages

| Package | Description |
|---|---|
| [`@rosclaw/rosbridge-client`](packages/rosbridge-client/) | Standalone TypeScript client for the rosbridge WebSocket protocol |
| [`@rosclaw/openclaw-plugin`](extensions/openclaw-plugin/) | OpenClaw extension: tools, hooks, skills, commands for ROS2 control |
| [`@rosclaw/openclaw-canvas`](extensions/openclaw-canvas/) | Real-time robot dashboard (Phase 3) |
| [`rosclaw_discovery`](ros2_ws/src/rosclaw_discovery/) | ROS2 Python node for capability auto-discovery |
| [`rosclaw_msgs`](ros2_ws/src/rosclaw_msgs/) | Custom ROS2 message/service definitions |

## Agent Tools

The AI agent has access to these ROS2 tools:

| Tool | Description |
|---|---|
| `ros2_publish` | Publish messages to any ROS2 topic |
| `ros2_subscribe_once` | Read the latest message from a topic |
| `ros2_service_call` | Call a ROS2 service |
| `ros2_action_goal` | Send action goals with feedback (Phase 2) |
| `ros2_param_get/set` | Get/set ROS2 node parameters |
| `ros2_list_topics` | Discover available topics |
| `ros2_camera_snapshot` | Capture a camera frame |
| `ros2_lidar_scene` | Build structured local scene state from `/scan + /odom` |
| `ros2_verify_motion` | Compare pre/post scene snapshots to validate motion success |

## Camera Debug Notes (From Real Integration)

This section summarizes practical lessons learned while integrating camera snapshots
through ROS2 + rosbridge + OpenClaw + Feishu.

### Recommended Snapshot Call

For the current TurtleBot/Gazebo setup:

```json
{"topic":"/camera/image_raw","type":"sensor_msgs/msg/Image","saveToFile":false,"timeout":15000}
```

Expected result fields:
- `format: "png"`
- `mimeType: "image/png"`
- `width`, `height`, `encoding`, `dataBytes`

### Snapshot Behavior (Current)

- Raw `sensor_msgs/msg/Image` is converted to **PNG** for better chat compatibility.
- `saveToFile` defaults to `false` to avoid path spam and excessive file writes.
- Tool text/details avoid embedding full base64 payloads in normal responses.
- If `saveToFile=true`, snapshot files are written under:
  - `/home/node/.openclaw/workspace/rosclaw_snapshots/`

### Common Failure Modes

1. **Tool not found**
   - Cause: RosClaw plugin failed to load (often missing dependencies like `zod`).
   - Check gateway logs for plugin load errors.

2. **Topic exists but snapshot times out**
   - Cause: camera topic not actually publishing frames.
   - Verify with:
     - `ros2 topic echo /camera/image_raw --once`
     - `ros2 topic info /camera/image_raw -v`

3. **Only path/text appears in chat, not image**
   - Cause: channel adapter sent text fallback instead of image content.
   - Ensure chat pipeline supports image message sending (or file upload flow).

4. **Context overflow**
   - Cause: accidentally returning raw image/base64 text in conversation.
   - Keep snapshot responses compact and avoid pasting binary payloads.

### Deployment Gotchas

- `docker restart` does **not** refresh code baked into an image.
  - If code is not bind-mounted, rebuild/recreate container after `git pull`.
- Verify the real plugin path in runtime:
  - e.g. `/opt/rosclaw/extensions/openclaw-plugin/...`
  - not always `/app/extensions/...`
- If source is mounted read-only (`:ro`), dependency install/update will fail (`EROFS`).
  - Use writable mount for development:
    - `-v ~/EmbodiedClaw:/opt/rosclaw:rw`

### Headless Gazebo Stability

`run_ros2_camera*.sh` scripts were hardened for headless stability:
- default no GUI
- software rendering env (`llvmpipe`)
- startup readiness checks before camera validation

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm typecheck        # Type-check without emitting
pnpm clean            # Remove build artifacts
```

## License

Apache-2.0
