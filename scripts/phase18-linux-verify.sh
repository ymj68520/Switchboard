#!/usr/bin/env bash
export PATH="$HOME/phase18-node/bin:$PATH"
cd /mnt/d/Programing/agent/plan-plugin
node scripts/claude-release-verify.mjs "$HOME/phase18-artifact/extracted"
echo "LINUX_VERIFY_EXIT=$?"
