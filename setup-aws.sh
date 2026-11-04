#!/usr/bin/env bash
# Agent Toolkit for AWS — setup commands (run on YOUR machine, not the sandbox).
# Profile: RMS | Project Region: ap-southeast-2 | Toolkit service Region: us-east-1
# Source: aws/agent-toolkit-for-aws setup-instructions/setup.md
set -euo pipefail

PROFILE="RMS"
REGION="ap-southeast-2"
TOOLKIT_REGION="us-east-1"   # Agent Toolkit service is only available in us-east-1

# Step 2 (macOS/Linux): install AWS CLI v2 if missing
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL 'https://awscli.amazonaws.com/v2/install.sh' | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
aws --version

# Step 3: set Region for the profile, then browser sign-in (YOU complete this in the browser)
aws configure set region "$REGION" --profile "$PROFILE"
aws login --region "$REGION" --profile "$PROFILE"   # opens browser; credentials valid 12h, renewable 90 days

# Step 4: verify access
aws sts get-caller-identity --profile "$PROFILE"

# Step 5: install Agent Toolkit (interactive wizard — complete the prompts yourself)
aws configure agent-toolkit --yes --region "$TOOLKIT_REGION" --profile "$PROFILE"

# Step 5b: in each MCP config the wizard wrote, add to the "aws-mcp" entry under mcpServers:
#   "env": { "AWS_MCP_PROXY_PROFILES": "RMS" }
# (leave command/args/timeout/transport untouched)

# Step 6: verify toolkit installation
aws agent-toolkit list-available-skills --region "$TOOLKIT_REGION" --profile "$PROFILE"

echo "Setup complete! Close this session and start a new one."
