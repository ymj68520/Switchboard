#!/usr/bin/env bash
export PATH="$HOME/phase18-node/bin:$PATH"
cd "$HOME/plan-plugin-linux/adapters/claude-code"
echo "=== full suite, maxWorkers=2 (constrained-VM adaptation) ==="
npx vitest run --maxWorkers=2 2>&1 | grep -aE "Test Files|Tests |FAIL" | head -30
echo "LINUX_RERUN_DONE"
