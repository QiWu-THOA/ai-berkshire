#!/usr/bin/env bash
# 把 pi-toolkit 安装到 pi 的配置目录。
#
# 为什么用「复制」而不是「软链」：
#   软链指向 npm 全局包目录，pi 升级/重装后路径变化 → 链断 → 扩展静默失效。
#   复制后即使 pi 升级也不受影响；需要更新时重跑本脚本即可。
#
# 用法：
#   ./install.sh              # 安装扩展 + 研究子代理（覆盖同名文件）
#   ./install.sh --check      # 只检查现状，不写任何文件
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
EXT_DIR="$PI_HOME/extensions"
AGENT_DIR="$PI_HOME/agents"

MODE="install"
[ "${1:-}" = "--check" ] && MODE="check"

# 定位 pi 包目录（用于取官方 subagent 示例扩展）
find_pi_pkg() {
	for base in \
		"$(npm root -g 2>/dev/null || true)" \
		"$HOME/.nvm/versions/node"/*/lib/node_modules \
		"/usr/local/lib/node_modules" \
		"/usr/lib/node_modules"; do
		[ -z "$base" ] && continue
		for cand in "$base/@earendil-works/pi-coding-agent"; do
			[ -d "$cand/examples/extensions/subagent" ] && { echo "$cand"; return 0; }
		done
	done
	return 1
}

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
info() { printf '  \033[2m·\033[0m %s\n' "$1"; }

echo "pi-toolkit → $PI_HOME"
echo

# --- 1. 官方 subagent 扩展（第三方代码，不 vendored 进仓库）---
SUBAGENT_SRC=""
if PKG="$(find_pi_pkg)"; then
	SUBAGENT_SRC="$PKG/examples/extensions/subagent"
	ok "找到 pi 包：$PKG"
else
	bad "找不到 pi 包目录（含 examples/extensions/subagent）——subagent 扩展无法安装"
fi

# --- 2. 检查模式 ---
if [ "$MODE" = "check" ]; then
	for f in cost-report.ts context-guard.ts; do
		[ -f "$EXT_DIR/$f" ] && ok "扩展已装：$f" || bad "扩展缺失：$f"
	done
	for f in subagent/index.ts subagent/agents.ts; do
		[ -f "$EXT_DIR/$f" ] && ok "subagent 已装：$f" || bad "subagent 缺失：$f"
		if [ -L "$EXT_DIR/$f" ]; then
			bad "  ↑ 是软链（pi 升级会断链），请重跑 install.sh 改为复制"
		fi
	done
	for f in web-scout fact-verifier primary-reader comps-analyst; do
		[ -f "$AGENT_DIR/$f.md" ] && ok "子代理已装：$f" || bad "子代理缺失：$f"
	done
	echo
	[ "$fail" = 0 ] && echo "全部就绪。" || echo "有缺失，请运行 ./install.sh"
	exit "$fail"
fi

# --- 3. 安装 ---
mkdir -p "$EXT_DIR/subagent" "$AGENT_DIR"

cp -f "$ROOT/extensions/cost-report.ts"   "$EXT_DIR/cost-report.ts"
cp -f "$ROOT/extensions/context-guard.ts" "$EXT_DIR/context-guard.ts"
ok "已写入 cost-report.ts / context-guard.ts"

if [ -n "$SUBAGENT_SRC" ]; then
	# 先删掉可能存在的软链，再复制实体文件
	rm -f "$EXT_DIR/subagent/index.ts" "$EXT_DIR/subagent/agents.ts"
	cp -f "$SUBAGENT_SRC/index.ts"  "$EXT_DIR/subagent/index.ts"
	cp -f "$SUBAGENT_SRC/agents.ts" "$EXT_DIR/subagent/agents.ts"
	ok "已写入 subagent 扩展（实体文件，非软链）"
fi

for f in "$ROOT"/agents/*.md; do
	cp -f "$f" "$AGENT_DIR/$(basename "$f")"
done
ok "已写入 $(ls "$ROOT"/agents/*.md | wc -l) 个研究子代理"

chmod +x "$ROOT"/tools/*.py 2>/dev/null || true

echo
echo "完成。重启 pi 生效（或在会话里 /reload，但 /reload 会作废前缀缓存）。"
echo "验证："
echo "  1. footer 出现 'ctx ... · Σ ... · \$... · N次 · hit ...' 状态行"
echo "  2. /cost        应该输出账本面板"
echo "  3. /guard       应该输出触发点说明"
echo "  4. 让模型列出工具，应包含 subagent"
echo
echo "检查现状（不写文件）：./install.sh --check"
