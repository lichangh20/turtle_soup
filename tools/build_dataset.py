# -*- coding: utf-8 -*-
"""
海龟汤题库构建脚本 (build_dataset.py)

数据来源：
  1) 网络公开题库：GitHub 仓库 anchorAnc/astrbot_plugin_TurtleSoup
     文件 questions_database.txt（master 分支），共 41 条，均为中文网络流行海龟汤。
     本脚本读取本地缓存 data/_web_source.txt（即上述文件的原样下载）。
  2) 编辑补充：若干世界经典“情境谜题(situation puzzle)”，全部附带渐进式提示，
     用来平衡口味（清淡/脑洞/温情），并示范“提示可有可无”的设计。

脚本职责：
  - 解析原始题库
  - 去重（037 与 015 为同一题）
  - 为每题归类到 5 大分类：qing/tuili/kongbu/wenqing/naodong
  - 为精选题目挂载渐进式提示（可选字段）
  - 合并经典补充题
  - 产出 js/puzzles.js（供 file:// 直接打开使用）与 data/puzzles.json

用法： python3 tools/build_dataset.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "_web_source.txt")
OUT_JS = os.path.join(ROOT, "js", "puzzles.js")
OUT_META_JS = os.path.join(ROOT, "js", "webmeta.js")
OUT_JSON = os.path.join(ROOT, "data", "puzzles.json")

# 在线题库地址（“从网上获取更多”使用；GitHub raw 最全，jsDelivr CDN 兜底，两者均支持浏览器跨域）
SOURCE_URLS = [
    "https://raw.githubusercontent.com/anchorAnc/astrbot_plugin_TurtleSoup/master/questions_database.txt",
    "https://cdn.jsdelivr.net/gh/anchorAnc/astrbot_plugin_TurtleSoup@master/questions_database.txt",
]

# 本地自带（离线）的网络题 ID：挑选最经典、口味分布均衡的一批；
# 其余网络题标记为“在线专享”，由“从网上获取更多”按钮实时拉取，保证该功能真的能带来新题。
BUNDLE_WEB_IDS = {
    1, 2, 3, 12, 18, 20,          # 推理
    4, 6, 9, 13,                  # 清淡
    11, 15, 16, 30, 35, 38,       # 恐怖
    14, 22, 24,                   # 温情
    23, 31,                       # 脑洞
}

LABELS = {"ID": "id", "标题": "title", "汤面": "surface",
          "汤底": "answer", "难度": "difficulty", "标签": "tags"}
LABEL_RE = re.compile(r"^(ID|标题|汤面|汤底|难度|标签)\s*[:：]\s*(.*)$")


def parse_source(text):
    """把原始 txt 解析成记录列表。记录以单独一行 --- 分隔，字段为 `标签: 值`。"""
    records, cur = [], {}
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        if line.strip().startswith("#"):
            continue
        if line.strip() == "---":
            if cur:
                records.append(cur)
                cur = {}
            continue
        m = LABEL_RE.match(line)
        if m:
            key = LABELS[m.group(1)]
            cur[key] = m.group(2).strip()
    if cur:
        records.append(cur)
    return records


# ---------------------------------------------------------------------------
# 分类：把网络题库每条 ID 映射到我们的 5 大分类。
#   qing    清汤 · 清淡日常，无人死亡，轻松机智
#   tuili   红汤 · 逻辑推理 / 悬疑，讲究“恍然大悟”的反转
#   kongbu  黑汤 · 恐怖惊悚 / 细思极恐 / 重口
#   wenqing 温情 · 温暖治愈 / 感人的情感反转
#   naodong 脑洞 · 科幻 / 超自然 / 脑筋急转弯式的奇思妙想
# ---------------------------------------------------------------------------
CATEGORY_BY_ID = {
    1: "tuili", 2: "tuili", 3: "tuili", 4: "qing", 5: "kongbu",
    6: "qing", 7: "tuili", 8: "qing", 9: "qing", 10: "kongbu",
    11: "kongbu", 12: "tuili", 13: "qing", 14: "wenqing", 15: "kongbu",
    16: "kongbu", 17: "kongbu", 18: "tuili", 19: "kongbu", 20: "tuili",
    21: "wenqing", 22: "wenqing", 23: "naodong", 24: "wenqing", 25: "tuili",
    26: "kongbu", 27: "kongbu", 28: "tuili", 29: "tuili", 30: "kongbu",
    31: "naodong", 32: "kongbu", 33: "kongbu", 34: "kongbu", 35: "kongbu",
    36: "kongbu", 37: "kongbu", 38: "kongbu", 39: "kongbu", 40: "kongbu",
    41: "kongbu",
}

# 精选题目的渐进式提示（键为网络题库 ID）。未列出的题目不带提示（提示本就是可选的）。
HINTS_BY_ID = {
    1: ["他的工作和“光”有关。", "他发现某样本该亮着的东西灭了。", "海上因此发生了一场他本可避免的灾难。"],
    2: ["她其实以前“喝过”一次海龟汤，情形很特殊。", "她是一场海难的幸存者。", "当年那锅救命的“汤”，并不是海龟肉做的。"],
    3: ["电话那头的声音和他养的动物有关。", "他其实看不见。", "他把狗的叫声，误解成了永别。"],
    11: ["妈妈“找到”我的方式很不寻常。", "家里除了我和妈妈，还有第三个人。", "我一动不敢动，是因为极度的恐惧。"],
    12: ["这里的火柴不是用来点火的。", "事情发生在天上，而不是地上。", "半根火柴，是抽签抽到的那一根。"],
    14: ["老人翻到第 30 页，并不是在读书的内容。", "他其实不识字。", "第 30 页的记号，是做给另一个人看的。"],
    18: ["晚上那个“影子”本不该存在。", "没有光，就不会有影子。", "门口立着的另一样东西，才是真相。"],
    20: ["哥哥当天本有机会去仓库，但他拒绝了。", "弟弟独自去了仓库玩。", "仓库里有一个会“吃人”的大家伙——冰柜。"],
    22: ["那盘排骨，是爸爸亲手做的。", "爸爸最近生了病，记性越来越差。", "其实从头到尾，都只有爸爸一个人。"],
    23: ["男子拥有一种特殊能力。", "他能看出关于每个人的某个数字。", "唯独婆婆那句话，让他意识到了可怕的事。"],
    31: ["“我”的身份，并不像开头看上去那样。", "这栋房子里住着机器人。", "写纸条的人和躺在地上的人，身份被悄悄调换了。"],
    33: ["他的工作每天都要和尸体打交道。", "警方在尸体上撒过会发绿光的荧光粉。", "他晚上做了连自己都不知道的事。"],
    34: ["“拔萝卜”是真的在拔什么东西。", "唱歌的“小朋友”并不正常。", "红萝卜、白萝卜，指的都不是蔬菜。"],
    39: ["“妈妈”并不是我们的亲妈。", "不听话的孩子会一个个消失。", "饺子馅的来源，非常可怕。"],
    41: ["“我”有很严重的心理疾病。", "“我”执着于寻找一个绝对安全的藏身之处。", "“我”最终认定，最安全的地方是妈妈的身体里面。"],
}

# 编辑补充：世界经典情境谜题，均附提示，用于平衡口味。
EXTRA_PUZZLES = [
    {
        "id": "c01", "title": "沙漠中的背包", "category": "tuili", "difficulty": 3,
        "surface": "一名男子直挺挺地躺在荒芜的沙漠正中央，早已没了呼吸。他身旁放着一个没有打开的背包。方圆几十里再无旁人，地上也没有任何脚印。他究竟是怎么死的？",
        "answer": "那个“背包”其实是一具没能打开的降落伞。男子和同伴乘坐热气球（或飞机）飞越沙漠，途中发生意外必须跳伞逃生，而他的降落伞在半空没有打开，坠落致死。",
        "hints": ["他不是渴死也不是饿死的，死亡来得非常突然。", "那个“背包”并不是用来装行李的。", "他是从很高很高的地方来到这里的。"],
        "tags": ["经典", "反转", "意外"],
    },
    {
        "id": "c02", "title": "罗密欧与朱丽叶", "category": "naodong", "difficulty": 2,
        "surface": "房间的地板上，罗密欧和朱丽叶双双倒地身亡。他们身边是一滩水和几片破碎的玻璃。房间门窗紧闭，没有任何搏斗或凶手进出的痕迹。发生了什么？",
        "answer": "罗密欧和朱丽叶是两条金鱼的名字。它们的鱼缸被撞倒摔碎了（多半是被一只猫碰倒的），金鱼离开水后窒息而死——地上的水和碎玻璃都来自那只鱼缸。",
        "hints": ["罗密欧和朱丽叶并不是两个人。", "那滩水和碎玻璃，其实来自同一样东西。", "“凶手”可能是一只猫。"],
        "tags": ["经典", "反转", "脑洞"],
    },
    {
        "id": "c03", "title": "消失的凶器", "category": "tuili", "difficulty": 3,
        "surface": "一个人被发现死在房间里，死因是头部遭钝器重击。房门从内部反锁，地上有一滩水，但警方翻遍现场，怎么也找不到凶器。凶手是怎么做到的？",
        "answer": "凶器是一根巨大的冰锥（或一块冰）。凶手用冰行凶后离开，冰逐渐融化成水，于是“凶器”就凭空消失了——地上那滩水，正是凶器留下的最后痕迹。",
        "hints": ["凶器一直都在现场，只是后来你看不见它了。", "地上那滩水是关键线索。", "如果案发时天气足够寒冷，凶器可能根本不会消失。"],
        "tags": ["经典", "密室", "推理"],
    },
    {
        "id": "c04", "title": "盲人提灯", "category": "wenqing", "difficulty": 1,
        "surface": "深夜的小路上，一个盲人走路时手里总提着一盏点亮的灯笼。有人不解地问他：“你反正看不见，为什么还要提着灯呢？”盲人笑着说了一句话，那人听后肃然起敬。他说了什么？",
        "answer": "盲人说：“我提灯不是为了照亮自己的路，而是为了让别人能看见我。这样在黑夜里，就不会有人不小心撞到我了——照亮别人，也是在守护我自己。”",
        "hints": ["这盏灯不是为他自己点的。", "他这句话既照亮了别人，也保护了自己。"],
        "tags": ["温情", "哲理", "善意"],
    },
    {
        "id": "c05", "title": "电梯里的男人", "category": "naodong", "difficulty": 3,
        "surface": "一个男人住在公寓 20 楼。每天上班，他都乘电梯到 10 楼，再走楼梯爬到 20 楼；可下班回来时，他却总是从 20 楼直接乘电梯到 1 楼。只有下雨天，他上楼才会一路乘到 20 楼。这是为什么？",
        "answer": "这个男人是个矮个子。早上进电梯，他只够得到较低的“10 楼”按钮，所以只能到 10 楼再爬楼梯；下雨天他带着雨伞，能用伞尖按到“20 楼”的按钮，于是直达。下楼按“1 楼”最低，谁都够得到，所以从不成问题。",
        "hints": ["这和男人的身高有关。", "下雨天，他手里会多出一样东西。", "关键在于他能不能“够到”电梯上的按钮。"],
        "tags": ["经典", "脑洞", "生活"],
    },
    {
        "id": "c06", "title": "三份牛排", "category": "naodong", "difficulty": 2,
        "surface": "两个母亲和两个女儿一起去餐厅吃饭，每人都点了一份牛排。可服务员一共只端上来三份牛排，最后每个人却都吃到了完整的一份，谁也没有分着吃。这是怎么回事？",
        "answer": "因为餐桌旁其实只坐了三个人：外婆、妈妈和女儿。外婆是妈妈的母亲，妈妈是女儿的母亲——所谓“两个母亲和两个女儿”，说的正是这祖孙三代同一批人。",
        "hints": ["“两个母亲和两个女儿”并不等于四个人。", "想一想三代人之间的身份关系。"],
        "tags": ["经典", "脑筋急转弯", "亲情"],
    },
    {
        "id": "c07", "title": "先点哪一个", "category": "naodong", "difficulty": 1,
        "surface": "一个人走进漆黑的房间，手里划着了一根火柴。房间里有一盏煤油灯、一支蜡烛和一个壁炉。他应该先点燃哪一样，才能让房间尽快亮起来？",
        "answer": "答案是——得先有那根划着的火柴本身。煤油灯、蜡烛、壁炉都要靠火柴去点，所以“先点燃”的永远是火柴；有了火，才谈得上点亮其它任何一样。",
        "hints": ["先仔细想想，题目到底在问“顺序”。", "没有它，其它三样都点不着。"],
        "tags": ["经典", "脑筋急转弯", "轻松"],
    },
]


def norm_web(rec):
    wid = int(rec["id"])
    tags = [t.strip() for t in re.split(r"[,，、]", rec.get("tags", "")) if t.strip()]
    try:
        diff = int(rec.get("difficulty", "3"))
    except ValueError:
        diff = 3
    return {
        "id": "w%03d" % wid,
        "title": rec.get("title", "无题").strip(),
        "category": CATEGORY_BY_ID.get(wid, "tuili"),
        "difficulty": max(1, min(5, diff)),
        "surface": rec.get("surface", "").strip(),
        "answer": rec.get("answer", "").strip(),
        "hints": HINTS_BY_ID.get(wid, []),
        "tags": tags,
        "source": "web",
    }


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        records = parse_source(f.read())

    web_all, seen_surface = [], set()
    for rec in records:
        if "surface" not in rec or "answer" not in rec:
            continue
        wid = int(rec["id"])
        if wid == 37:  # 037 与 015「作家的生日会」为同一题，去重
            continue
        p = norm_web(rec)
        skey = re.sub(r"\s+", "", p["surface"])
        if skey in seen_surface:
            continue
        seen_surface.add(skey)
        web_all.append((wid, p))

    classics = []
    for ex in EXTRA_PUZZLES:
        ex = dict(ex)
        ex.setdefault("hints", [])
        ex.setdefault("tags", [])
        ex["source"] = "classic"
        classics.append(ex)

    # 本地自带：经典补充题 + 被选入 BUNDLE_WEB_IDS 的网络题
    bundled = classics + [p for (wid, p) in web_all if wid in BUNDLE_WEB_IDS]
    # 完整题库（含“在线专享”）：用于 puzzles.json 参考与本地服务器兜底
    full = classics + [p for (wid, p) in web_all]

    # ---- 产出 js/puzzles.js（离线自带，供 file:// 直接打开）----
    header = (
        "/* 本文件由 tools/build_dataset.py 自动生成，请勿手动修改。\n"
        " * 这是【离线自带】的精选题库；更多题目可点击页面上的“从网上获取更多”实时拉取。\n"
        " * 题库来源：\n"
        " *   1) 网络公开题库 anchorAnc/astrbot_plugin_TurtleSoup (questions_database.txt)\n"
        " *   2) 若干世界经典情境谜题（编辑补充，均附提示）\n"
        " * 字段：id / title / category / difficulty(1-5) / surface / answer / hints[] / tags[] / source\n"
        " */\n"
        "window.BUNDLED_PUZZLES = "
    )
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(header)
        f.write(json.dumps(bundled, ensure_ascii=False, indent=2))
        f.write(";\n")

    # ---- 产出 js/webmeta.js（在线拉取时用于归类 / 挂提示 / 数据源地址）----
    meta = {
        "sources": SOURCE_URLS,
        "categoryById": {str(k): v for k, v in CATEGORY_BY_ID.items()},
        "hintsById": {str(k): v for k, v in HINTS_BY_ID.items()},
    }
    with open(OUT_META_JS, "w", encoding="utf-8") as f:
        f.write("/* 自动生成：在线题库的分类 / 提示 / 数据源，供“从网上获取更多”使用。 */\n")
        f.write("window.WEB_META = ")
        f.write(json.dumps(meta, ensure_ascii=False, indent=2))
        f.write(";\n")

    # ---- 产出 data/puzzles.json（完整题库，参考 & 服务器兜底）----
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(full, f, ensure_ascii=False, indent=2)

    # 统计
    from collections import Counter
    print("离线自带：%d 题  （经典 %d + 网络精选 %d）"
          % (len(bundled), len(classics), len(bundled) - len(classics)))
    print("  分类分布：%s" % dict(Counter(p["category"] for p in bundled)))
    print("在线专享（需联网获取）：%d 题" % (len(full) - len(bundled)))
    print("完整题库合计：%d 题" % len(full))
    print("带提示的题（完整）：%d" % sum(1 for p in full if p["hints"]))
    print("已写出：%s" % OUT_JS)
    print("已写出：%s" % OUT_META_JS)
    print("已写出：%s" % OUT_JSON)


if __name__ == "__main__":
    main()
