#!/usr/bin/env bash
set -euo pipefail

if command -v agit >/dev/null 2>&1; then
  agit doctor
elif command -v npx >/dev/null 2>&1; then
  npx agit doctor
else
  echo "agit is not installed"
  echo "Install: npm i -g @hudishkin/agit"
  exit 1
fi
