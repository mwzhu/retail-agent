#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <run-id>\n' "$0" >&2
  exit 2
fi

verification_run_id=$1
if [[ ! $verification_run_id =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Invalid run ID.\n' >&2
  exit 2
fi

verification_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verification_repo_root=$(CDPATH= cd -- "$verification_script_dir/../../../.." && pwd)
verification_run_dir="$verification_repo_root/.audit/verification/runs/$verification_run_id"

if [[ ! -d $verification_run_dir ]]; then
  printf 'No active run state for %s. Nothing to clean.\n' "$verification_run_id"
  exit 0
fi
for verification_state_name in pid port repo-root evidence-path; do
  if [[ ! -f $verification_run_dir/$verification_state_name ]]; then
    printf 'Missing run state: %s. Refusing cleanup.\n' "$verification_run_dir/$verification_state_name" >&2
    exit 1
  fi
done

verification_pid=$(<"$verification_run_dir/pid")
verification_port=$(<"$verification_run_dir/port")
verification_recorded_root=$(<"$verification_run_dir/repo-root")
verification_evidence_path=$(<"$verification_run_dir/evidence-path")

if [[ $verification_recorded_root != "$verification_repo_root" ]]; then
  printf 'Recorded repository root does not match this checkout. Refusing cleanup.\n' >&2
  exit 1
fi
case $verification_run_dir in
  "$verification_repo_root/.audit/verification/runs/$verification_run_id") ;;
  *) printf 'Unexpected run directory. Refusing cleanup.\n' >&2; exit 1 ;;
esac

if [[ $verification_pid =~ ^[0-9]+$ ]] && kill -0 "$verification_pid" 2>/dev/null; then
  verification_command=$(ps -p "$verification_pid" -o command=)
  verification_cwd=$(lsof -a -p "$verification_pid" -d cwd -Fn | sed -n 's/^n//p')
  if [[ $verification_cwd != "$verification_repo_root" || $verification_command != *"src/server/index.ts"* ]]; then
    printf 'PID %s no longer matches the launched server. Refusing to signal it.\n' "$verification_pid" >&2
    exit 1
  fi
  if ! lsof -nP -a -p "$verification_pid" -iTCP:"$verification_port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'PID %s no longer owns recorded port %s. Refusing to signal it.\n' "$verification_pid" "$verification_port" >&2
    exit 1
  fi

  kill -TERM "$verification_pid"
  for _ in {1..50}; do
    if ! kill -0 "$verification_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$verification_pid" 2>/dev/null; then
    kill -KILL "$verification_pid"
  fi
fi

rm -rf -- "$verification_run_dir"
printf 'Removed scratch state for %s.\n' "$verification_run_id"
printf 'Evidence retained at %s.\n' "$verification_evidence_path"
