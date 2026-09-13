#!/usr/bin/env bash
set -u
STATE=$1
TASK_ID=$2
printf 'working: synthetic worker made observable progress\n' > "$STATE/$TASK_ID.status"
printf 'progress=worker-observed-progress\n' > "$STATE/$TASK_ID.progress"
sleep 300
