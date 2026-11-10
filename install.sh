#!/usr/bin/env bash
set -e

# agy-multi installer for macOS and Linux
# Usage:
#   Local:  ./install.sh
#   Remote: curl -fsSL https://raw.githubusercontent.com/iqbal-codes/agy-multi/main/install.sh | bash

REPO_URL="${REPO_URL:-https://github.com/iqbal-codes/agy-multi.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
SOURCE_DIR="${SOURCE_DIR:-$HOME/.local/share/agy-multi}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info() {
    printf "${BLUE}==>${NC} %s\n" "$1"
}

success() {
    printf "${GREEN}==>${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}warning:${NC} %s\n" "$1"
}

error() {
    printf "${RED}error:${NC} %s\n" "$1" >&2
    exit 1
}

printf "${BOLD}Installing agy-multi (multi-account failover for Antigravity)...${NC}\n\n"

# 1. Check or install Bun
if ! command -v bun >/dev/null 2>&1; then
    if [ -x "$HOME/.bun/bin/bun" ]; then
        export PATH="$HOME/.bun/bin:$PATH"
    else
        info "Bun runtime not found in PATH."
        info "Installing Bun via official installer (https://bun.sh)..."
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
        if ! command -v bun >/dev/null 2>&1; then
            error "Bun installation failed or PATH not updated. Please install Bun manually from https://bun.sh."
        fi
    fi
fi

# 2. Determine work directory (local checkout vs remote curl)
if [ -f "package.json" ] && grep -q '"name": "agy-multi"' package.json 2>/dev/null; then
    info "Using local workspace: $(pwd)"
    WORK_DIR="$(pwd)"
else
    info "Setting up repository in $SOURCE_DIR..."
    mkdir -p "$(dirname "$SOURCE_DIR")"
    if [ -d "$SOURCE_DIR/.git" ]; then
        info "Updating existing repository in $SOURCE_DIR..."
        git -C "$SOURCE_DIR" pull --ff-only 2>/dev/null || true
    else
        info "Cloning repository from $REPO_URL..."
        git clone --depth=1 "$REPO_URL" "$SOURCE_DIR"
    fi
    WORK_DIR="$SOURCE_DIR"
fi

cd "$WORK_DIR"

# 3. Install dependencies
info "Installing dependencies..."
bun install

# 4. Build standalone binaries
info "Compiling standalone single-binary executables..."
bun run build

# 5. Copy binaries to install directory
mkdir -p "$INSTALL_DIR"
cp -f dist/agy-multi "$INSTALL_DIR/agy-multi"
cp -f dist/agy-multi-acp "$INSTALL_DIR/agy-multi-acp"
chmod +x "$INSTALL_DIR/agy-multi" "$INSTALL_DIR/agy-multi-acp"
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
    codesign -s - -f "$INSTALL_DIR/agy-multi" "$INSTALL_DIR/agy-multi-acp" >/dev/null 2>&1 || true
fi

success "Installed agy-multi and agy-multi-acp to $INSTALL_DIR"

# 6. Check PATH
case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        warn "$INSTALL_DIR is not in your current PATH."
        warn "Add this to your shell config (~/.bashrc or ~/.zshrc):"
        printf "\n    export PATH=\"%s:\$PATH\"\n\n" "$INSTALL_DIR"
        ;;
esac

# 7. Check for official Google agy binary
if ! command -v agy >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/agy" ] && [ ! -x "/usr/local/bin/agy" ]; then
    warn "Official Antigravity CLI ('agy') binary was not detected."
    info "Installing official Antigravity CLI via https://antigravity.google/cli/install.sh..."
    if curl -fsSL https://antigravity.google/cli/install.sh | bash; then
        success "Installed official Antigravity CLI ('agy') successfully!"
    else
        warn "Could not automatically install agy. Please install it manually from https://antigravity.google."
    fi
fi

# 8. Ensure T3 Code & ACP rules exist in ~/.gemini/GEMINI.md
GEMINI_DIR="$HOME/.gemini"
GEMINI_MD="$GEMINI_DIR/GEMINI.md"
if [ ! -f "$GEMINI_MD" ]; then
    mkdir -p "$GEMINI_DIR"
    cat << 'EOF' > "$GEMINI_MD"
# T3 Code & Subagent Orchestration Rules

When running inside T3 Code (`T3_ACP_MCP_NODE` is present in the environment or host is T3 Code):
1. **Do not use internal `invoke_subagent` for user-facing multi-agent work.**
   Antigravity's internal `invoke_subagent` runs exclusively within the local Antigravity CLI daemon and does not create child task cards or threads in the T3 Code UI.
2. **Use T3 Code's `delegate_task` via the ACP MCP bridge:**
   ```bash
   ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call delegate_task '{"task":"<task description>","target":{"providerInstanceId":"antigravity-acp","model":"gemini-3.8-flash"},"mode":"async","clientRequestId":"<unique-id>"}'
   ```
   This spawns a first-class subagent thread directly inside T3 Code, complete with a UI progress card, live status, and a verbatim thread link (`<t3-thread://...>`).
3. **Handle Background Processes & Long Commands Explicitly:**
   - In ACP clients like T3 Code, T3 Code cannot track Antigravity's internal daemon tasks (`manage_task`), and `t3_background_wait` is unsupported for this provider. Furthermore, ACP is turn-based, so Antigravity cannot proactively wake up the client when a background task completes.
   - **For commands expected to finish (builds, tests, linters, scripts):**
     - Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) to avoid premature backgrounding.
     - Never end a turn with a generic "I launched it in background" message if the command was supposed to finish. If a command is backgrounded unexpectedly, check `manage_task(Action='status')` or inspect the task log before returning, or inform the user clearly with the exact log path.
   - **For true background daemons (e.g., dev servers, file watchers, background services):**
     - Explicitly state:
       1. The command running and service/port.
       2. The Antigravity Task ID (e.g., `task-XX`).
       3. The full log file link (`file:///.../task-XX.log`).
       4. How to check or terminate it (`manage_task`).
EOF
    info "Provisioned T3 Code & ACP orchestration rules in $GEMINI_MD"
elif ! grep -q "T3_ACP_MCP_NODE" "$GEMINI_MD" 2>/dev/null; then
    printf "\n" >> "$GEMINI_MD"
    cat << 'EOF' >> "$GEMINI_MD"
# T3 Code & Subagent Orchestration Rules

When running inside T3 Code (`T3_ACP_MCP_NODE` is present in the environment or host is T3 Code):
1. **Do not use internal `invoke_subagent` for user-facing multi-agent work.**
   Antigravity's internal `invoke_subagent` runs exclusively within the local Antigravity CLI daemon and does not create child task cards or threads in the T3 Code UI.
2. **Use T3 Code's `delegate_task` via the ACP MCP bridge:**
   ```bash
   ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call delegate_task '{"task":"<task description>","target":{"providerInstanceId":"antigravity-acp","model":"gemini-3.8-flash"},"mode":"async","clientRequestId":"<unique-id>"}'
   ```
   This spawns a first-class subagent thread directly inside T3 Code, complete with a UI progress card, live status, and a verbatim thread link (`<t3-thread://...>`).
3. **Handle Background Processes & Long Commands Explicitly:**
   - In ACP clients like T3 Code, T3 Code cannot track Antigravity's internal daemon tasks (`manage_task`), and `t3_background_wait` is unsupported for this provider. Furthermore, ACP is turn-based, so Antigravity cannot proactively wake up the client when a background task completes.
   - **For commands expected to finish (builds, tests, linters, scripts):**
     - Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) to avoid premature backgrounding.
     - Never end a turn with a generic "I launched it in background" message if the command was supposed to finish. If a command is backgrounded unexpectedly, check `manage_task(Action='status')` or inspect the task log before returning, or inform the user clearly with the exact log path.
   - **For true background daemons (e.g., dev servers, file watchers, background services):**
     - Explicitly state:
       1. The command running and service/port.
       2. The Antigravity Task ID (e.g., `task-XX`).
       3. The full log file link (`file:///.../task-XX.log`).
       4. How to check or terminate it (`manage_task`).
EOF
    info "Appended T3 Code & ACP orchestration rules to $GEMINI_MD"
fi

# 9. Verify
if [ -x "$INSTALL_DIR/agy-multi" ]; then
    printf "\n${GREEN}${BOLD}Installation complete!${NC}\n\n"
    printf "Quick start:\n"
    printf "  1. Add an account:      agy-multi profile add <slug>\n"
    printf "  2. List profiles:       agy-multi profile list\n"
    printf "  3. Check quotas:        agy-multi quota\n"
    printf "  4. Check token usage:   agy-multi usage\n"
    printf "  5. Connect ACP host:    agy-multi acp  (or binary: agy-multi-acp)\n\n"
fi
