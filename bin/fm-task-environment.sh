#!/usr/bin/env bash
# Add and display the task environment dimension in the authoritative backlog.
#
# Usage:
#   fm-task-environment.sh add <work|personal|fleet> <id> <title> [tasks-axi add flags]
#   fm-task-environment.sh validate <work|personal|fleet>
#
# tasks-axi has no environment field in its add, update, show, or list help.
# The validated `[environment: <value>]` title suffix therefore keeps the
# dimension in the same markdown record tasks-axi owns and renders at a glance.
set -euo pipefail

usage() { echo 'usage: fm-task-environment.sh add <work|personal|fleet> <id> <title> [tasks-axi add flags] | validate <environment>' >&2; }
valid_environment() { case "$1" in work|personal|fleet) ;; *) echo "error: environment must be work, personal, or fleet (got '$1')" >&2; return 1 ;; esac; }

case "${1:-}" in
  validate) [ "$#" -eq 2 ] || { usage; exit 2; }; valid_environment "$2" ;;
  add)
    [ "$#" -ge 4 ] || { usage; exit 2; }
    environment=$2 id=$3 title=$4
    shift 4
    valid_environment "$environment"
    exec tasks-axi add "$id" "$title [environment: $environment]" "$@"
    ;;
  *) usage; exit 2 ;;
esac
