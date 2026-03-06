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
3. **Do not leak file path**: Reply with image only. Do not show local file paths unless user explicitly asks for file upload/debug.

## Example

```
Tool: ros2_camera_snapshot
Topic: /camera/image_raw/compressed
Type: sensor_msgs/msg/CompressedImage
saveToFile: false
```

## Tips

- The tool supports both `sensor_msgs/msg/CompressedImage` and raw `sensor_msgs/msg/Image`.
- Prefer compressed topic (`/camera/image_raw/compressed`) for chat delivery compatibility.
- If the robot publishes only raw images, pass `topic: "/camera/image_raw"` explicitly.
- Local file persistence is optional (`saveToFile: true`) and should be used only for upload/debug workflows.
- Use `ros2_list_topics` to find available camera topics.
- If the user asks about a specific direction, note that you can only show what the robot's camera is currently pointed at.
- For multiple cameras, ask which one the user wants to see.
