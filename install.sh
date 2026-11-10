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

# 8. Ensure ACP orchestration rules exist in ~/.gemini/GEMINI.md
GEMINI_DIR="$HOME/.gemini"
GEMINI_MD="$GEMINI_DIR/GEMINI.md"
if [ ! -f "$GEMINI_MD" ]; then
    mkdir -p "$GEMINI_DIR"
    cat << 'EOF' > "$GEMINI_MD"
# ACP & Multi-Agent Orchestration Rules

These rules apply when running under an ACP (Agent Client Protocol) host (such as T3 Code, Zed, or other ACP editor clients):

1. **Synchronous Execution & Command Handling (All ACP Clients):**
   - ACP is turn-based. ACP client editors cannot track or display Antigravity's internal daemon tasks (`manage_task`), nor can background tasks unilaterally notify the client outside an active turn.
   - **For commands expected to finish (builds, tests, linters, scripts):**
     - Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) to ensure synchronous execution and prevent premature backgrounding.
     - Never finish a turn claiming a task was launched in the background if it was supposed to finish. Inspect the status or logs before concluding the turn.
   - **For long-running background daemons (e.g., dev servers, watchers):**
     - Explicitly state:
       1. The running command, service name, and port.
       2. The task ID (e.g., `task-XX`).
       3. The full absolute log file path (`file:///.../task-XX.log`).
       4. How to inspect or terminate it (`manage_task`).

2. **Subagents & Multi-Agent Work (Agnostic vs T3 Code):**
   - **Do not use internal `invoke_subagent` for user-facing tasks:** Antigravity's internal `invoke_subagent` runs exclusively inside the local daemon and is invisible to ACP client interfaces.
   - **When running inside T3 Code (`T3_ACP_MCP_NODE` is present or host is T3 Code):**
     - Delegate subagents using T3 Code's ACP MCP bridge:
       ```bash
       ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call delegate_task '{"task":"<task description>","target":{"providerInstanceId":"antigravity-acp","model":"gemini-3.8-flash"},"mode":"async","clientRequestId":"<unique-id>"}'
       ```
       This spawns a first-class child thread and progress card directly in T3 Code.
   - **When running in other ACP clients (e.g. Zed, Neovim, generic ACP):**
     - Execute the task directly within the active thread rather than spawning hidden background subagents, unless the host provides a client-specific delegation tool.
EOF
    info "Provisioned ACP orchestration rules in $GEMINI_MD"
elif ! grep -q "ACP & Multi-Agent Orchestration Rules\|T3_ACP_MCP_NODE" "$GEMINI_MD" 2>/dev/null; then
    printf "\n" >> "$GEMINI_MD"
    cat << 'EOF' >> "$GEMINI_MD"
# ACP & Multi-Agent Orchestration Rules

These rules apply when running under an ACP (Agent Client Protocol) host (such as T3 Code, Zed, or other ACP editor clients):

1. **Synchronous Execution & Command Handling (All ACP Clients):**
   - ACP is turn-based. ACP client editors cannot track or display Antigravity's internal daemon tasks (`manage_task`), nor can background tasks unilaterally notify the client outside an active turn.
   - **For commands expected to finish (builds, tests, linters, scripts):**
     - Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) to ensure synchronous execution and prevent premature backgrounding.
     - Never finish a turn claiming a task was launched in the background if it was supposed to finish. Inspect the status or logs before concluding the turn.
   - **For long-running background daemons (e.g., dev servers, watchers):**
     - Explicitly state:
       1. The running command, service name, and port.
       2. The task ID (e.g., `task-XX`).
       3. The full absolute log file path (`file:///.../task-XX.log`).
       4. How to inspect or terminate it (`manage_task`).

2. **Subagents & Multi-Agent Work (Agnostic vs T3 Code):**
   - **Do not use internal `invoke_subagent` for user-facing tasks:** Antigravity's internal `invoke_subagent` runs exclusively inside the local daemon and is invisible to ACP client interfaces.
   - **When running inside T3 Code (`T3_ACP_MCP_NODE` is present or host is T3 Code):**
     - Delegate subagents using T3 Code's ACP MCP bridge:
       ```bash
       ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call delegate_task '{"task":"<task description>","target":{"providerInstanceId":"antigravity-acp","model":"gemini-3.8-flash"},"mode":"async","clientRequestId":"<unique-id>"}'
       ```
       This spawns a first-class child thread and progress card directly in T3 Code.
   - **When running in other ACP clients (e.g. Zed, Neovim, generic ACP):**
     - Execute the task directly within the active thread rather than spawning hidden background subagents, unless the host provides a client-specific delegation tool.
EOF
    info "Appended ACP orchestration rules to $GEMINI_MD"
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
