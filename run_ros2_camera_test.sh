xhost +local:docker
docker rm -f ros2-gui 2>/dev/null || true

docker run --rm -it \
  --name ros2-gui \
  --network host \
  --runtime runc \
  -e DISPLAY=$DISPLAY \
  -e QT_X11_NO_MITSHM=1 \
  -e TURTLEBOT3_MODEL=burger \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  --device /dev/dri \
  -v /media/user/B29202FA9202C2B91/tb3_gz_cam:/tb3_gz_cam:rw \
  -v /media/user/B29202FA9202C2B91/tb3_gz_cam/ros_env.sh:/etc/profile.d/ros_env.sh:ro \
  --entrypoint /tb3_gz_cam/entrypoint.sh \
  rosclaw/ros2:with-image-tools \
  bash -lc '
    set -e

    # 确保 Gazebo 能找到 turtlebot3 的 models（model://turtlebot3_world 等）
    export GZ_SIM_RESOURCE_PATH=/opt/ros/jazzy/share/turtlebot3_gazebo/models:${GZ_SIM_RESOURCE_PATH}

    # 1) rosbridge
    ros2 launch rosbridge_server rosbridge_websocket_launch.xml &
    sleep 2

    # 2) Gazebo Sim：server+gui + world（单次启动，避免竞态）
    ros2 launch ros_gz_sim gz_sim.launch.py \
      gz_args:="-r -s -g -v2 /tb3_gz_cam/worlds/turtlebot3_world_with_cam.world" \
      on_exit_shutdown:=true &
    GZSERVER_PID=$!

    # 等仿真时钟起来（表示 world 已就绪）
    echo "Waiting for Gazebo transport..."
    for i in {1..60}; do
      if gz topic -l 2>/dev/null | grep -qi clock; then
        echo "Gazebo transport ready"
        break
      fi
      sleep 0.5
    done
    # 4) 生成 TurtleBot3（burger）
    ros2 launch turtlebot3_gazebo spawn_turtlebot3.launch.py x_pose:=-2.0 y_pose:=-0.5 &
    sleep 2

    # 5) robot_state_publisher
    ros2 launch turtlebot3_gazebo robot_state_publisher.launch.py use_sim_time:=true &

    # 6) TB3 bridge（建议先开着，保证 /scan /odom 等都正常）
    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/opt/ros/jazzy/share/turtlebot3_gazebo/params/turtlebot3_burger_bridge.yaml &

    # 7) camera bridge
    ros2 run ros_gz_bridge parameter_bridge --ros-args \
      -p config_file:=/tb3_gz_cam/params/camera_bridge.yaml &

    # 让容器跟随 gzserver 生命周期
    wait $GZSERVER_PID
  '