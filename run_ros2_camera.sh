#!/usr/bin/env bash
set -euo pipefail

ENABLE_GZ_GUI="${ENABLE_GZ_GUI:-0}"
IMAGE_TAG="${IMAGE_TAG:-rosclaw/ros2:with-image-tools}"

docker rm -f ros2-gui 2>/dev/null || true

docker run --rm -it \
  --name ros2-gui \
  --network host \
  --runtime runc \
  -e TURTLEBOT3_MODEL=burger \
  -e LIBGL_ALWAYS_SOFTWARE=1 \
  -e MESA_LOADER_DRIVER_OVERRIDE=llvmpipe \
  -e GALLIUM_DRIVER=llvmpipe \
  -e QT_QUICK_BACKEND=software \
  -e ENABLE_GZ_GUI="$ENABLE_GZ_GUI" \
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

    # Optional GUI, disabled by default for stability.
    if [ "${ENABLE_GZ_GUI}" = "1" ] && [ -n "${DISPLAY:-}" ]; then
      ros2 launch ros_gz_sim gz_sim.launch.py \
        gz_args:="-g -v2" \
        on_exit_shutdown:=true &
    fi

    # Wait for Gazebo transport to come up.
    for _ in $(seq 1 40); do
      if gz topic -l 2>/dev/null | grep -q "/clock"; then
        break
      fi
      sleep 0.5
    done

    ros2 launch turtlebot3_gazebo spawn_turtlebot3.launch.py x_pose:=-2.0 y_pose:=-0.5 &
    sleep 2
    ros2 launch turtlebot3_gazebo robot_state_publisher.launch.py use_sim_time:=true &

    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/opt/ros/jazzy/share/turtlebot3_gazebo/params/turtlebot3_burger_bridge.yaml &

    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/tb3_gz_cam/params/camera_bridge.yaml &

    # Wait until /camera/image_raw is advertised by the bridge.
    for _ in $(seq 1 40); do
      if ros2 topic list 2>/dev/null | grep -q "^/camera/image_raw$"; then
        break
      fi
      sleep 0.5
    done

    echo "Simulation started. Verify camera stream with:"
    echo "  ros2 topic echo /camera/image_raw --once"

    wait "$GZSERVER_PID"
  '
