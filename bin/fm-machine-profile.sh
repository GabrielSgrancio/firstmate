#!/usr/bin/env bash
# Read this home's machine identity and its autonomous-authority boundary.
#
# Usage: fm-machine-profile.sh [show|name|requires-captain <action>]
#
# config/machine-profile is one lowercase machine name such as `work-mac`.
# It never describes capability, dispatch, projects, or delivery mode. The
# conservative work-mac authority policy requires a current captain instruction
# for project edits, remote pushes, and merges; unconfigured and other profiles
# retain Firstmate's existing authority rules.
set -eu

FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
PROFILE_FILE="$CONFIG/machine-profile"

profile() {
  local value
  value=$(sed -n '1p' "$PROFILE_FILE" 2>/dev/null || true)
  case "$value" in
    [a-z0-9][a-z0-9-]*) printf '%s\n' "$value" ;;
    *) printf 'default\n' ;;
  esac
}

case "${1:-show}" in
  name) profile ;;
  show)
    name=$(profile)
    if [ "$name" = work-mac ]; then
      printf 'machine=%s\nauthority=current captain instruction required for project edits, remote pushes, and merges\ncapability=unchanged\n' "$name"
    else
      printf 'machine=%s\nauthority=existing Firstmate policy\ncapability=unchanged\n' "$name"
    fi
    ;;
  requires-captain)
    [ "$#" -eq 2 ] || { echo 'usage: fm-machine-profile.sh requires-captain <project-edit|push|merge>' >&2; exit 2; }
    case "$2" in project-edit|push|merge) ;; *) echo "error: unknown authority action: $2" >&2; exit 2 ;; esac
    [ "$(profile)" = work-mac ]
    ;;
  *) echo 'usage: fm-machine-profile.sh [show|name|requires-captain <action>]' >&2; exit 2 ;;
esac
