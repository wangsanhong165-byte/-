"""Single time-anchor for every LLM-facing context.

All consumers (main prompt, initiative prompt, extraction, compilation) format
"now" through this module so the model sees one consistent local clock and one
interpretation rule for relative time in memories. Stdlib-only so app.memory
and app.runtime can both import it without cycles.
"""

from __future__ import annotations

from datetime import datetime

_WEEKDAYS = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")

_TIME_RULE = (
    "下方记忆与对话记录均为历史观察：其中的“今天/昨晚/凌晨”等相对时间表述"
    "一律以上面的当前时间重新换算理解；已过期的状态不要再当作当前事实提起。"
)


def current_time_context(now: datetime | None = None) -> str:
    """Human-readable local clock, e.g. “2026年9月4日 星期五 23:30（本地时区）”."""
    local = (now or datetime.now()).astimezone()
    return (
        f"{local.year}年{local.month}月{local.day}日 "
        f"{_WEEKDAYS[local.weekday()]} {local:%H:%M}（本地时区）"
    )


def time_anchor(now: datetime | None = None) -> str:
    """Full anchor block: current time + the memory interpretation rule."""
    return f"[当前时间] {current_time_context(now)}\n{_TIME_RULE}"
