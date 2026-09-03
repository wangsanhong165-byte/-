"""text_lang 内容自动检测——中英混排输出问题的回归锚点。

实测证据（2026-09-03, alims 音色）:
- 纯中文  zh=3.76s(正确) / en=2.16s(丢字)
- 纯英文  en=4.48s(正确) / zh=3.60s(劣化)
- 混排    zh=4.48s(正确) / en=3.56s(劣化)
text_lang 必须匹配实际合成文本的主导语言; 角色卡 reply_language 是
"期望回复语言", 与模型实际输出可能不一致 (如 EN 角色对中文用户回中文)。
"""
from app.modules.tts.engines import gsvi_v2


def test_infer_text_lang_picks_zh_for_chinese_and_mixed():
    assert gsvi_v2._infer_text_lang("今天天气真好，一起散步吧。") == "zh"
    assert gsvi_v2._infer_text_lang("我现在在用 AI 写代码，效果真的很 OK！") == "zh"


def test_infer_text_lang_picks_en_for_pure_english():
    assert gsvi_v2._infer_text_lang("Today is a nice day, let us go for a walk.") == "en"
    assert gsvi_v2._infer_text_lang("OK, sounds great!") == "en"
