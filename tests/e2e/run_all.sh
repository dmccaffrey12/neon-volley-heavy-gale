#!/usr/bin/env bash
# Unified 5-Tier E2E Test Runner for SUMMER HEAT 3D

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TIER="all"
PORT="${E2E_PORT:-8080}"
ARTIFACTS_DIR="./qa-artifacts"
SKIP_VIDEO=0
SCENARIO="all"

usage() {
  cat <<'EOF'
Usage: ./tests/e2e/run_all.sh [OPTIONS]

Run SUMMER HEAT 3D E2E tests across Tiers 1-5.

Options:
  --tier <1|2|3|4|5|all>    Select tier to run (default: all)
  --port <PORT>             HTTP port for Tier 4 browser QA (default: $E2E_PORT or 8080)
  --artifacts-dir <DIR>     Output directory for Tier 4 PNG/.webm/JSON artifacts (default: ./qa-artifacts)
  --skip-video              Skip .webm video recording in Tier 4
  --scenario <IDS|all>      Filter Tier 4 scenarios (e.g. T4-S1,T4-S2 or all; default: all)
  -h, --help                Show this help message and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      [[ $# -ge 2 ]] || { echo "ERROR: --tier requires an argument" >&2; exit 2; }
      TIER="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "ERROR: --port requires an argument" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --artifacts-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --artifacts-dir requires an argument" >&2; exit 2; }
      ARTIFACTS_DIR="$2"
      shift 2
      ;;
    --skip-video)
      SKIP_VIDEO=1
      shift
      ;;
    --scenario)
      [[ $# -ge 2 ]] || { echo "ERROR: --scenario requires an argument" >&2; exit 2; }
      SCENARIO="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$TIER" in
  1|2|3|4|5|all) ;;
  *)
    echo "ERROR: Invalid --tier '$TIER'. Expected one of: 1, 2, 3, 4, 5, all" >&2
    exit 2
    ;;
esac

if [[ -z "${SCENARIO//[[:space:],]/}" ]]; then
  echo "ERROR: --scenario must not be empty" >&2
  exit 2
fi

run_tier1() {
  echo "=== [E2E] Running Tier 1: Category-Partition Feature Coverage ==="
  node --test "${REPO_ROOT}/tests/e2e/tier1_features.test.mjs"
}

run_tier2() {
  echo "=== [E2E] Running Tier 2: Boundary Value Analysis & Corner Cases ==="
  node --test "${REPO_ROOT}/tests/e2e/tier2_boundaries.test.mjs"
}

run_tier3() {
  echo "=== [E2E] Running Tier 3: Cross-Feature Pairwise Combinatorial Suite ==="
  node --test "${REPO_ROOT}/tests/e2e/tier3_pairwise.test.mjs"
}

run_tier4() {
  echo "=== [E2E] Running Tier 4: Headless SwiftShader WebGL2 & Offline PWA QA ==="
  local args=(
    "--port" "${PORT}"
    "--artifacts-dir" "${ARTIFACTS_DIR}"
    "--scenario" "${SCENARIO}"
  )
  if [[ "${SKIP_VIDEO}" -eq 1 ]]; then
    args+=("--skip-video")
  fi
  PYTHONDONTWRITEBYTECODE=1 python3 -B "${REPO_ROOT}/tests/e2e/tier4_browser_e2e.py" "${args[@]}"
}

run_tier5() {
  echo "=== [E2E] Running Tier 5: Adversarial & Hardening Regression Suite ==="
  node --test "${REPO_ROOT}/tests/e2e/tier5_adversarial.test.mjs"
}

if [[ "$TIER" == "all" || "$TIER" == "1" ]]; then
  run_tier1
fi
if [[ "$TIER" == "all" || "$TIER" == "2" ]]; then
  run_tier2
fi
if [[ "$TIER" == "all" || "$TIER" == "3" ]]; then
  run_tier3
fi
if [[ "$TIER" == "all" || "$TIER" == "4" ]]; then
  run_tier4
fi
if [[ "$TIER" == "all" || "$TIER" == "5" ]]; then
  run_tier5
fi

echo "=== [E2E] Completed requested tier(s): ${TIER} ==="
