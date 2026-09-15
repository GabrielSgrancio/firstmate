#!/usr/bin/env bash
# Behavior test for the provider-neutral Context Broker and its Router dispatch handoff.
# bin/fm-context-broker.mjs owns the source under test.
set -u

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$ROOT/tests/fm-context-broker.test.mjs"
