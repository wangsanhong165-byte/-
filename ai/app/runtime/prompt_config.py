"""Per-character policy for model prompt sources."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any


PROMPT_SOURCE_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "language",
        "title": "语言规则",
        "description": "控制模型使用哪种语言回答。",
        "dynamic": False,
        "editable": True,
    },
    {
        "id": "persona",
        "title": "角色设定",
        "description": "角色身份、语气、背景与行为边界。",
        "dynamic": False,
        "editable": True,
    },
    {
        "id": "pinned",
        "title": "固定记忆",
        "description": "用户手动置顶的固定记忆，每轮必进上下文，不会被压缩丢失。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "memory_summary",
        "title": "记忆摘要",
        "description": "每轮根据当前角色记忆动态生成的长期上下文。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "relevant_memory",
        "title": "相关记忆",
        "description": "根据本轮内容检索出的相关历史片段。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "temporal",
        "title": "时间感知",
        "description": "注入当前日期时间，并声明记忆为历史观察、相对时间以当前时间换算。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "emotion",
        "title": "当前情绪",
        "description": "当前角色情绪对语言表达的动态影响。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "character_state",
        "title": "角色状态",
        "description": "关系、情绪和其他角色运行状态。",
        "dynamic": True,
        "editable": True,
    },
    {
        "id": "output_protocol",
        "title": "输出协议",
        "description": "维持结构化回复、动作、表情和语音链路所必需。",
        "dynamic": False,
        "editable": False,
    },
)


class PromptConfigStore:
    """Persist and resolve prompt-source policies behind one small interface."""

    MAX_CONTENT_CHARS = 12_000
    _CHARACTER_ID = re.compile(r"^[A-Za-z0-9_-]+$")
    _SOURCE_DEFINITIONS = {
        item["id"]: item for item in PROMPT_SOURCE_DEFINITIONS
    }

    def __init__(self, base_dir: Path | str):
        self._base_dir = Path(base_dir)

    def _path_for(self, character_id: str) -> Path:
        if not character_id or not self._CHARACTER_ID.fullmatch(character_id):
            raise ValueError("invalid character id")
        return self._base_dir / f"{character_id}.json"

    @staticmethod
    def _default_entry() -> dict[str, str]:
        return {"mode": "default", "content": ""}

    def get(self, character_id: str) -> dict[str, dict[str, str]]:
        path = self._path_for(character_id)
        persisted: dict[str, Any] = {}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                persisted = loaded.get("sources", loaded)
                if not isinstance(persisted, dict):
                    persisted = {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            persisted = {}

        result: dict[str, dict[str, str]] = {}
        for source_id in self._SOURCE_DEFINITIONS:
            try:
                result[source_id] = self._normalize_entry(
                    source_id,
                    persisted.get(source_id, self._default_entry()),
                )
            except ValueError:
                result[source_id] = self._default_entry()
        return result

    def set(
        self,
        character_id: str,
        updates: dict[str, Any],
    ) -> dict[str, dict[str, str]]:
        if not isinstance(updates, dict):
            raise ValueError("prompt source config must be an object")

        normalized = self.get(character_id)
        for source_id, entry in updates.items():
            if source_id not in self._SOURCE_DEFINITIONS:
                raise ValueError(f"unknown prompt source: {source_id}")
            normalized[source_id] = self._normalize_entry(source_id, entry)

        path = self._path_for(character_id)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_suffix(".json.tmp")
        temp_path.write_text(
            json.dumps({"version": 1, "sources": normalized}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(path)
        return deepcopy(normalized)

    def resolve(
        self,
        character_id: str,
        source_id: str,
        default_content: str,
    ) -> str | None:
        if source_id not in self._SOURCE_DEFINITIONS:
            raise ValueError(f"unknown prompt source: {source_id}")
        entry = self.get(character_id)[source_id]
        if entry["mode"] == "disabled":
            return None
        if entry["mode"] == "replace":
            return entry["content"]
        return str(default_content)

    def definitions(self) -> list[dict[str, Any]]:
        return deepcopy(list(PROMPT_SOURCE_DEFINITIONS))

    def delete(self, character_id: str) -> bool:
        """Remove a character's persisted prompt-source policy."""
        path = self._path_for(character_id)
        existed = path.exists()
        path.unlink(missing_ok=True)
        return existed

    def _normalize_entry(self, source_id: str, entry: Any) -> dict[str, str]:
        if not isinstance(entry, dict):
            raise ValueError(f"prompt source {source_id} must be an object")
        mode = str(entry.get("mode", "default"))
        content = str(entry.get("content", "")).replace("\r\n", "\n").strip()
        if mode not in {"default", "replace", "disabled"}:
            raise ValueError(f"invalid prompt source mode: {mode}")
        if len(content) > self.MAX_CONTENT_CHARS:
            raise ValueError(
                f"prompt source {source_id} exceeds {self.MAX_CONTENT_CHARS} characters"
            )
        definition = self._SOURCE_DEFINITIONS[source_id]
        if not definition["editable"] and mode != "default":
            raise ValueError(f"prompt source {source_id} is required and read-only")
        if mode == "replace" and not content:
            raise ValueError(f"replacement for {source_id} cannot be empty")
        if mode != "replace":
            content = ""
        return {"mode": mode, "content": content}
