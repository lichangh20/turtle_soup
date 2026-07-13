#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
海龟汤 · 本地服务器
================================================================
一个零依赖（仅 Python 标准库）的本地服务器：
  1. 托管前端静态页面（http://localhost:8000）
  2. /api/fetch  —— 从网上拉取更多中文海龟汤题库（代理，规避跨域）
  3. /api/ask    —— 由 AI 主持人裁判玩家的提问（是/不是/无关/接近…）
  4. /api/hint   —— 由 AI 主持人给一条不泄底的提示
  5. /api/health —— 报告 AI 主持人是否就绪

AI 主持人使用 Anthropic 的 Claude 模型（默认 claude-opus-4-8）。
- 想启用「AI 主持」：先设置环境变量  export ANTHROPIC_API_KEY=sk-ant-...
- 未设置密钥也能正常游玩：前端会自动切换为「本地裁判（近似）」。
- 想换更快的模型：export TURTLE_SOUP_MODEL=claude-haiku-4-5

运行：
    python3 server.py            # 启动并自动打开浏览器
    python3 server.py --port 8080
    python3 server.py --no-open
"""
import argparse
import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest
from urllib import error as urlerror

ROOT = os.path.dirname(os.path.abspath(__file__))

# ---- Anthropic Claude 配置 ----
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
MODEL = os.environ.get("TURTLE_SOUP_MODEL", "claude-opus-4-8")

# ---- 在线题库地址（与 tools/build_dataset.py 保持一致；raw 最全，CDN 兜底）----
SOURCE_URLS = [
    "https://raw.githubusercontent.com/anchorAnc/astrbot_plugin_TurtleSoup/master/questions_database.txt",
    "https://cdn.jsdelivr.net/gh/anchorAnc/astrbot_plugin_TurtleSoup@master/questions_database.txt",
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
}

# ---------- AI 主持人：裁判提问 ----------
ASK_SYSTEM = """你是「海龟汤」情境推理游戏的主持人。你已知这道题的【汤面】（玩家能看到的谜面）和【汤底】（真相，玩家看不到）。
玩家会向你提出只能用「是/否」回答的问题，你要严格依据【汤底】来判断，并从下列选项中给出唯一判定：
- "是"：按照汤底，问题描述的情况成立。
- "不是"：按照汤底，问题描述的情况不成立。
- "是也不是"：部分成立、部分不成立，或需要分情况讨论。
- "无关"：该问题与还原真相无关，或汤底中根本没有相关信息。
- "接近"：玩家的猜测方向正确、已经接近真相，但还不完整。
- "恭喜"：玩家已经说对了汤底的关键真相（核心因果说对了）。
判定原则：
1. 只依据【汤底】判断，绝不编造汤底之外的设定。
2. 判断要果断、稳定：同样的问题应给出一致的判定。
3. note 用一句话给出简短的引导；除非判定为"恭喜"，否则绝不能剧透汤底的关键信息。
4. 玩家可能直接猜最终真相：说对核心用"恭喜"，方向对但不完整用"接近"。
5. solved 仅在判定为"恭喜"时为 true。
只输出结构化 JSON 结果。"""

ASK_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["是", "不是", "是也不是", "无关", "接近", "恭喜"]},
        "note": {"type": "string"},
        "solved": {"type": "boolean"},
    },
    "required": ["verdict", "note", "solved"],
    "additionalProperties": False,
}

HINT_SYSTEM = """你是「海龟汤」游戏的主持人。根据【汤面】和【汤底】，给玩家一条循序渐进、绝不直接泄底的提示，帮助他们向真相靠近一步。
只给一条提示，简短（一两句话），语气俏皮一点。不要说出汤底的关键答案。只输出结构化 JSON。"""

HINT_SCHEMA = {
    "type": "object",
    "properties": {"hint": {"type": "string"}},
    "required": ["hint"],
    "additionalProperties": False,
}

GEN_SYSTEM = """你是一位擅长创作「海龟汤」（情境推理谜题）的出题人。请原创一道有趣、逻辑自洽、能够通过「是 / 否」提问一步步推理出来的海龟汤。
要求：
- surface（汤面）：简洁、悬疑、令人费解，30~80 字，只描述表象，绝不含任何解释。
- answer（汤底）：完整揭示真相与前因后果，让汤面里每个细节都说得通，60~200 字，答案唯一。
- hints：2~3 条循序渐进、不直接泄底的提示。
- difficulty：1~5 的整数。
- tags：2~4 个中文标签。
- category：从 qing(清淡) / tuili(推理) / kongbu(恐怖) / wenqing(温情) / naodong(脑洞) 中选最贴切的一个。
- 若给定 flavor 口味，请贴合它。内容要有创意、有反转，但不必过度血腥。
只输出结构化 JSON。"""

GEN_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "surface": {"type": "string"},
        "answer": {"type": "string"},
        "hints": {"type": "array", "items": {"type": "string"}},
        "difficulty": {"type": "integer"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "category": {"type": "string", "enum": ["qing", "tuili", "kongbu", "wenqing", "naodong"]},
    },
    "required": ["title", "surface", "answer", "hints", "difficulty", "tags", "category"],
    "additionalProperties": False,
}


def has_api_key():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def call_claude(system, user, schema=None, max_tokens=600):
    """调用 Anthropic Messages API。返回 (data_dict_or_text, error_or_None)。"""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None, "no_api_key"
    body = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    # 结构化输出：opus-4-8 / haiku-4-5 均支持，保证返回合法 JSON。
    if schema is not None:
        body["output_config"] = {"format": {"type": "json_schema", "schema": schema}}

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urlrequest.Request(
        ANTHROPIC_ENDPOINT,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        return None, "http_%d: %s" % (e.code, detail)
    except Exception as e:  # noqa: BLE001
        return None, "error: %s" % e

    if payload.get("stop_reason") == "refusal":
        return None, "refusal"

    text = ""
    for block in payload.get("content", []):
        if block.get("type") == "text":
            text = block.get("text", "")
            break
    if schema is not None:
        try:
            return json.loads(text), None
        except (ValueError, TypeError):
            return None, "parse_error: %s" % text[:200]
    return text, None


def build_ask_user(surface, answer, question, history):
    parts = ["【汤面】\n" + surface.strip(),
             "\n【汤底（仅你可见，严禁泄露给玩家）】\n" + answer.strip()]
    if history:
        lines = []
        for h in history[-8:]:
            q = (h.get("q") or "").strip()
            v = (h.get("verdict") or "").strip()
            if q:
                lines.append("玩家问：%s → 你答：%s" % (q, v))
        if lines:
            parts.append("\n【已问过的问题（保持判定一致）】\n" + "\n".join(lines))
    parts.append("\n【玩家现在的提问】\n" + question.strip())
    return "\n".join(parts)


def fetch_online_bank():
    """从在线题库拉取原始文本，返回 (text, source_url) 或 (None, None)。"""
    for url in SOURCE_URLS:
        try:
            req = urlrequest.Request(url, headers={"User-Agent": "turtle-soup-local/1.0"})
            with urlrequest.urlopen(req, timeout=25) as resp:
                text = resp.read().decode("utf-8", "ignore")
                if text and len(text) > 500:
                    return text, url
        except Exception:  # noqa: BLE001
            continue
    return None, None


class Handler(BaseHTTPRequestHandler):
    server_version = "TurtleSoup/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write("  · %s\n" % (fmt % args))

    # ---------- 通用响应 ----------
    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            return self._send_json({"ok": True, "ai": has_api_key(), "model": MODEL})
        if path == "/api/fetch":
            text, source = fetch_online_bank()
            if text:
                return self._send_json({"ok": True, "text": text, "source": source})
            return self._send_json({"ok": False, "reason": "fetch_failed"}, status=502)
        return self._serve_static(path)

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ask":
            return self._handle_ask()
        if path == "/api/hint":
            return self._handle_hint()
        if path == "/api/generate":
            return self._handle_generate()
        self._send_json({"ok": False, "reason": "not_found"}, status=404)

    def _handle_ask(self):
        body = self._read_body()
        surface = (body.get("surface") or "").strip()
        answer = (body.get("answer") or "").strip()
        question = (body.get("question") or "").strip()
        history = body.get("history") or []
        if not surface or not answer or not question:
            return self._send_json({"ok": False, "reason": "bad_request"}, status=400)
        user = build_ask_user(surface, answer, question, history)
        result, err = call_claude(ASK_SYSTEM, user, schema=ASK_SCHEMA, max_tokens=500)
        if err:
            return self._send_json({"ok": False, "reason": err})
        return self._send_json({
            "ok": True,
            "verdict": result.get("verdict", "无关"),
            "note": result.get("note", ""),
            "solved": bool(result.get("solved", False)),
            "model": MODEL,
        })

    def _handle_hint(self):
        body = self._read_body()
        surface = (body.get("surface") or "").strip()
        answer = (body.get("answer") or "").strip()
        asked = body.get("asked") or []
        if not surface or not answer:
            return self._send_json({"ok": False, "reason": "bad_request"}, status=400)
        user = "【汤面】\n%s\n\n【汤底（仅你可见）】\n%s" % (surface, answer)
        if asked:
            user += "\n\n【已经给过的提示，请不要重复】\n" + "\n".join("- " + a for a in asked[-5:])
        result, err = call_claude(HINT_SYSTEM, user, schema=HINT_SCHEMA, max_tokens=300)
        if err:
            return self._send_json({"ok": False, "reason": err})
        return self._send_json({"ok": True, "hint": result.get("hint", ""), "model": MODEL})

    def _handle_generate(self):
        body = self._read_body()
        flavor = (body.get("flavor") or "").strip()
        user = "请原创一道全新的海龟汤。"
        if flavor:
            user += "口味偏向：%s。" % flavor
        result, err = call_claude(GEN_SYSTEM, user, schema=GEN_SCHEMA, max_tokens=1200)
        if err:
            return self._send_json({"ok": False, "reason": err})
        return self._send_json({"ok": True, "puzzle": result, "model": MODEL})

    # ---------- 静态文件 ----------
    def _serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        # 规范化，禁止越权访问
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            return self._send_json({"ok": False, "reason": "forbidden"}, status=403)
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="海龟汤本地服务器")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    url = "http://%s:%d/" % ("localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port)
    ai = "✅ 已就位（%s）" % MODEL if has_api_key() else "⚠️ 未配置 ANTHROPIC_API_KEY —— 将使用「本地裁判(近似)」"

    print("\n  🐢  海龟汤 已启动")
    print("  ────────────────────────────────────────")
    print("  本地地址 :  %s" % url)
    print("  AI 主持人:  %s" % ai)
    print("  在线题库 :  可点击「从网上获取更多」实时拉取")
    print("  停止服务 :  按 Ctrl+C")
    print("  ────────────────────────────────────────\n")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  🐢  已停止，回见！\n")
        httpd.server_close()


if __name__ == "__main__":
    main()
