# Take Photo

## When to Use

Use this skill when the user wants to see what the robot sees:
- "What do you see?"
- "Take a photo"
- "Show me the camera"
- "Send me a picture"

## Steps

1. **Capture image**: Use `ros2_camera_snapshot` to grab a frame from the camera topic.
2. **Return the image**: The tool returns the image data which will be displayed inline in the chat.

## Example

```
Tool: ros2_camera_snapshot
Topic: /camera/image_raw (or /camera/image_raw/compressed)
```

## Tips

- The tool supports both `sensor_msgs/msg/CompressedImage` and raw `sensor_msgs/msg/Image`.
- If the robot publishes only raw images, pass `topic: "/camera/image_raw"` explicitly.
- Use `ros2_list_topics` to find available camera topics.
- If the user asks about a specific direction, note that you can only show what the robot's camera is currently pointed at.
- For multiple cameras, ask which one the user wants to see.
