#!/usr/bin/env bash
set -euo pipefail

ENABLE_GZ_GUI="${ENABLE_GZ_GUI:-1}"
IMAGE_TAG="${IMAGE_TAG:-rosclaw/ros2:latest}"

if [ "${ENABLE_GZ_GUI}" = "1" ] && [ -n "${DISPLAY:-}" ]; then
  xhost +local:docker >/dev/null 2>&1 || true
fi

docker rm -f ros2-gui 2>/dev/null || true

docker run --rm -it \
  --name ros2-gui \
  --network host \
  --runtime runc \
  -e DISPLAY="${DISPLAY:-}" \
  -e QT_X11_NO_MITSHM=1 \
  -e TURTLEBOT3_MODEL=burger \
  -e LIBGL_ALWAYS_SOFTWARE=1 \
  -e MESA_LOADER_DRIVER_OVERRIDE=llvmpipe \
  -e GALLIUM_DRIVER=llvmpipe \
  -e QT_QUICK_BACKEND=software \
  -e ENABLE_GZ_GUI="$ENABLE_GZ_GUI" \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  --device /dev/dri \
  -v /media/user/B29202FA9202C2B91/tb3_gz_cam:/tb3_gz_cam:rw \
  -v /media/user/B29202FA9202C2B91/tb3_gz_cam/ros_env.sh:/etc/profile.d/ros_env.sh:ro \
  --entrypoint /tb3_gz_cam/entrypoint.sh \
  "$IMAGE_TAG" \
  bash -lc '
    set -euo pipefail

    export GZ_SIM_RESOURCE_PATH=/opt/ros/jazzy/share/turtlebot3_gazebo/models:${GZ_SIM_RESOURCE_PATH:-}

    ros2 launch rosbridge_server rosbridge_websocket_launch.xml &
    sleep 2

    ros2 launch ros_gz_sim gz_sim.launch.py \
      gz_args:="-r -s -v2 /tb3_gz_cam/worlds/turtlebot3_world_with_cam.world" \
      on_exit_shutdown:=true &
    GZSERVER_PID=$!

    if [ "${ENABLE_GZ_GUI}" = "1" ] && [ -n "${DISPLAY:-}" ]; then
      ros2 launch ros_gz_sim gz_sim.launch.py \
        gz_args:="-g -v2" \
        on_exit_shutdown:=true &
    else
      echo "GUI disabled (set ENABLE_GZ_GUI=1 and DISPLAY to enable)."
    fi

    sleep 3
    ros2 launch turtlebot3_gazebo spawn_turtlebot3.launch.py x_pose:=-2.0 y_pose:=-0.5 &
    sleep 2
    ros2 launch turtlebot3_gazebo robot_state_publisher.launch.py use_sim_time:=true &

    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/opt/ros/jazzy/share/turtlebot3_gazebo/params/turtlebot3_burger_bridge.yaml &

    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/tb3_gz_cam/params/camera_bridge.yaml &

    wait "$GZSERVER_PID"
  '
