#!/bin/bash
# 双击本文件即可启动「海龟汤」本地服务器（macOS）。
# 想启用 AI 主持人：先在终端里 export ANTHROPIC_API_KEY=sk-ant-... 再运行本脚本。
cd "$(dirname "$0")" || exit 1
echo ""
echo "  🐢  正在启动海龟汤…（关闭本窗口或按 Ctrl+C 即可停止）"
echo ""
if command -v python3 >/dev/null 2>&1; then
  exec python3 server.py "$@"
else
  echo "  ✗ 没有找到 python3，请先安装 Python 3。"
  echo "    （或者直接双击 index.html 也能离线游玩）"
  read -r -p "  按回车键退出…" _
fi
