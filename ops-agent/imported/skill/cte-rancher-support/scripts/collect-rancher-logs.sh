#!/usr/bin/env bash
set -euo pipefail

context=''
namespace=''
moltbot_id=''
pod_name=''
container=''
since_minutes=60
output_directory="$(pwd)/rancher-logs"
previous=false

usage() {
  cat <<'EOF'
Usage:
  collect-rancher-logs.sh --context CONTEXT --namespace NAMESPACE \
    (--moltbot-id ID | --pod-name POD) [--container NAME] \
    [--since-minutes MINUTES] [--output-directory DIR] [--previous]
EOF
}

while (($#)); do
  case "$1" in
    --context) context=${2-}; shift 2 ;;
    --namespace) namespace=${2-}; shift 2 ;;
    --moltbot-id) moltbot_id=${2-}; shift 2 ;;
    --pod-name) pod_name=${2-}; shift 2 ;;
    --container) container=${2-}; shift 2 ;;
    --since-minutes) since_minutes=${2-}; shift 2 ;;
    --output-directory) output_directory=${2-}; shift 2 ;;
    --previous) previous=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || { printf 'kubectl was not found in PATH.\n' >&2; exit 1; }
[[ -n $context && -n $namespace ]] || { usage >&2; exit 2; }
[[ $context =~ ^[A-Za-z0-9._:-]+$ ]] || { printf 'Invalid context.\n' >&2; exit 2; }
[[ $namespace =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { printf 'Invalid namespace.\n' >&2; exit 2; }
[[ $since_minutes =~ ^[0-9]+$ ]] && ((since_minutes >= 1 && since_minutes <= 10080)) || { printf 'since-minutes must be 1..10080.\n' >&2; exit 2; }

if [[ -n $moltbot_id && -n $pod_name ]] || [[ -z $moltbot_id && -z $pod_name ]]; then
  printf 'Specify exactly one of --moltbot-id or --pod-name.\n' >&2
  exit 2
fi
[[ -z $moltbot_id || $moltbot_id =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'Invalid moltbot ID.\n' >&2; exit 2; }
[[ -z $pod_name || $pod_name =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { printf 'Invalid pod name.\n' >&2; exit 2; }
[[ -z $container || $container =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { printf 'Invalid container name.\n' >&2; exit 2; }

for resource in pods pods/log; do
  allowed=$(kubectl --context "$context" auth can-i get "$resource" -n "$namespace" 2>/dev/null || true)
  [[ $allowed == yes ]] || { printf 'Read access denied for %s in %s/%s.\n' "$resource" "$context" "$namespace" >&2; exit 1; }
done

if [[ -n $moltbot_id ]]; then
  prefix="pod/moltbot-$moltbot_id-"
  pod_name=$(
    kubectl --context "$context" get pods -n "$namespace" \
      --field-selector=status.phase=Running \
      --sort-by=.metadata.creationTimestamp -o name |
      awk -v prefix="$prefix" 'index($0, prefix) == 1 {sub(/^pod\//, ""); last=$0} END {print last}'
  )
  [[ -n $pod_name ]] || { printf "No Running pod starts with 'moltbot-%s-' in %s/%s.\n" "$moltbot_id" "$context" "$namespace" >&2; exit 1; }
fi

read -r -a containers <<<"$(kubectl --context "$context" get pod "$pod_name" -n "$namespace" -o jsonpath='{.spec.containers[*].name}')"
if [[ -z $container ]]; then
  ((${#containers[@]} == 1)) || { printf 'Pod has multiple containers; specify --container. Available: %s\n' "${containers[*]}" >&2; exit 2; }
  container=${containers[0]}
else
  found=false
  for item in "${containers[@]}"; do [[ $item == "$container" ]] && found=true; done
  $found || { printf 'Container is not present. Available: %s\n' "${containers[*]}" >&2; exit 2; }
fi

mkdir -p -- "$output_directory"
stamp=$(date '+%Y%m%d-%H%M%S')
suffix=''
$previous && suffix='-previous'
output_file="$output_directory/$context-$namespace-$pod_name-$container$suffix-$stamp.log"
raw_file=$(mktemp)
trap 'rm -f -- "$raw_file"' EXIT

log_args=(--context "$context" logs "$pod_name" -n "$namespace" -c "$container" "--since=${since_minutes}m" --timestamps=true)
$previous && log_args+=(--previous)
kubectl "${log_args[@]}" >"$raw_file"

LC_ALL=C sed -E \
  -e 's/([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn][[:space:]]*[:=][[:space:]]*[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)[^,;[:space:]"]+/\1[REDACTED]/g' \
  -e 's/("?(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|cookie)"?[[:space:]]*[:=][[:space:]]*"?)[^",;[:space:]]+/\1[REDACTED]/g' \
  -e 's#(https?://[^[:space:]/:]+:)[^@[:space:]]+@#\1[REDACTED]@#g' \
  -e 's/(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)/\1[REDACTED_PHONE]\2/g' \
  -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[REDACTED_EMAIL]/g' \
  "$raw_file" >"$output_file"

phase=$(kubectl --context "$context" get pod "$pod_name" -n "$namespace" -o jsonpath='{.status.phase}')
created=$(kubectl --context "$context" get pod "$pod_name" -n "$namespace" -o jsonpath='{.metadata.creationTimestamp}')
restarts=$(kubectl --context "$context" get pod "$pod_name" -n "$namespace" -o jsonpath='{range .status.containerStatuses[*]}{.restartCount}{"\n"}{end}' | awk '{sum += $1} END {print sum+0}')

printf 'Context: %s\nNamespace: %s\nPod: %s\nContainer: %s\nPhase: %s\nCreated: %s\nRestartCount: %s\nSinceMinutes: %s\nPrevious: %s\nSanitizedLog: %s\n' \
  "$context" "$namespace" "$pod_name" "$container" "$phase" "$created" "$restarts" "$since_minutes" "$previous" "$output_file"
