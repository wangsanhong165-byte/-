"""Typed V3 management-event adapter for RuntimeManager."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.runtime.management import get_manager
from app.transport.domain_event import DomainEvent

logger = logging.getLogger("transport.management")


class ManagementFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ManagementHandler:
    """Delegate V3 management requests to the runtime's single manager."""

    def __init__(self):
        self._manager = get_manager()

    async def handle(
        self,
        action: str,
        params: dict,
        request_id: str = "",
    ) -> list[DomainEvent]:
        try:
            data = await self._execute(action, params)
            return [DomainEvent.create("management.result", {
                "requestId": request_id,
                "action": action,
                "data": data,
            })]
        except ManagementFailure as exc:
            return [DomainEvent.create("management.failed", {
                "requestId": request_id,
                "action": action,
                "code": exc.code,
                "message": exc.message,
            })]

    async def _execute(self, action: str, params: dict) -> dict[str, Any]:
        if action == "get_character_catalog":
            return await asyncio.to_thread(self._manager.get_character_catalog)
        if action == "get_character_detail":
            try:
                return await asyncio.to_thread(
                    self._manager.get_character_detail,
                    str(params.get("character_id", "")),
                )
            except (KeyError, ValueError, OSError) as exc:
                raise ManagementFailure("character_detail_unavailable", str(exc)) from exc
        if action == "update_character":
            changes = dict(params)
            character_id = str(changes.pop("character_id", ""))
            try:
                return await asyncio.to_thread(
                    self._manager.update_character,
                    character_id,
                    changes,
                )
            except (KeyError, ValueError, RuntimeError, OSError) as exc:
                raise ManagementFailure("character_edit_failed", str(exc)) from exc
        if action == "create_character":
            try:
                return await asyncio.to_thread(self._manager.create_character, params)
            except (ValueError, OSError) as exc:
                raise ManagementFailure("character_import_invalid", str(exc)) from exc
        if action == "delete_character":
            try:
                return await asyncio.to_thread(
                    self._manager.delete_character,
                    str(params.get("character_id", "")),
                )
            except (KeyError, ValueError, RuntimeError, OSError) as exc:
                raise ManagementFailure("character_delete_failed", str(exc)) from exc
        if action == "get_voice_catalog":
            return await asyncio.to_thread(self._manager.get_voice_catalog)
        if action == "add_voice":
            try:
                return await asyncio.to_thread(self._manager.add_voice, params)
            except (ValueError, OSError) as exc:
                raise ManagementFailure("voice_add_invalid", str(exc)) from exc
        if action == "get_model_catalog":
            return await asyncio.to_thread(self._manager.get_model_catalog)
        if action == "register_model":
            try:
                return await asyncio.to_thread(
                    self._manager.register_model, str(params.get("model_id", ""))
                )
            except (ValueError, OSError) as exc:
                raise ManagementFailure("model_register_invalid", str(exc)) from exc
        if action == "get_histories":
            return {"histories": self._manager.get_history_list()}
        if action == "load_history":
            return self._manager.load_history(params.get("history_uid", ""))
        if action == "create_history":
            return self._manager.create_history()
        if action == "delete_history":
            return self._manager.delete_history(params.get("history_uid", ""))

        if action == "get_pinned":
            return {"content": self._manager.get_pinned()}
        if action == "set_pinned":
            content = self._manager.set_pinned(params.get("content", ""))
            return {"content": content}
        if action == "get_prompt_override":
            return self._manager.get_prompt_override()
        if action == "set_prompt_override":
            try:
                return self._manager.set_prompt_override(str(params.get("content", "")))
            except ValueError as exc:
                raise ManagementFailure("prompt_override_invalid", str(exc)) from exc
        if action == "get_prompt_config":
            try:
                return self._manager.get_prompt_config(
                    str(params.get("character_id", ""))
                )
            except ValueError as exc:
                raise ManagementFailure("prompt_config_invalid", str(exc)) from exc
        if action == "set_prompt_config":
            sources = params.get("sources", {})
            if not isinstance(sources, dict):
                raise ManagementFailure("prompt_config_invalid", "sources must be an object")
            try:
                return self._manager.set_prompt_config(
                    str(params.get("character_id", "")),
                    sources,
                    str(params.get("addition", "")),
                )
            except ValueError as exc:
                raise ManagementFailure("prompt_config_invalid", str(exc)) from exc
        if action == "get_prompt_view":
            try:
                return self._manager.get_prompt_view(
                    str(params.get("character_id", ""))
                )
            except ValueError as exc:
                raise ManagementFailure("prompt_view_unavailable", str(exc)) from exc
        if action == "get_memories":
            return {"memories": self._manager.get_memories(
                bool(params.get("include_inactive", False)),
                int(params.get("limit", 200)),
            )}
        if action == "get_character_self_view":
            return {"view": self._manager.get_character_self_view()}
        if action == "get_memory_view":
            return {"view": self._manager.get_memory_view(
                query=str(params.get("query", "")),
                category=str(params.get("category", "all")),
                limit=int(params.get("limit", 200)),
            )}
        if action == "get_compiled_memory_view":
            return {"view": self._manager.get_compiled_memory_view()}
        if action == "update_memory_view":
            result = self._manager.update_memory_view(str(params.get("ref", "")), params)
            return self._result_or_raise(result, "memory_update_failed")
        if action == "forget_memory_view":
            result = self._manager.forget_memory_view(str(params.get("ref", "")))
            return self._result_or_raise(result, "memory_forget_failed")
        if action == "get_voice_status_view":
            return {"view": self._manager.get_voice_status_view()}
        if action == "get_capability_view":
            return {"view": await self._manager.get_capability_view()}
        if action == "get_turns":
            return {"turns": self._manager.get_turns(int(params.get("limit", 100)))}
        if action == "get_turn_detail":
            result = self._manager.get_turn_detail(str(params.get("turn_id", "")))
            return self._result_or_raise(result, "turn_not_found")
        if action == "get_runtime_diagnostics":
            return self._manager.get_runtime_diagnostics()
        if action == "update_memory":
            result = self._manager.update_memory(int(params.get("memory_id", 0)), params)
            return self._result_or_raise(result, "memory_update_failed")
        if action == "forget_memory":
            return self._manager.forget_memory(int(params.get("memory_id", 0)))
        if action == "get_system_metrics":
            return self._manager.get_system_metrics()
        if action == "get_tools":
            return {"tools": await self._manager.get_tools()}
        if action == "set_tool_enabled":
            result = self._manager.set_tool_enabled(
                str(params.get("name", "")),
                bool(params.get("enabled", True)),
            )
            return self._result_or_raise(result, "tool_settings_failed")

        if action == "switch_character":
            result = self._manager.switch_character(params.get("character_id", ""))
            return self._result_or_raise(result, "switch_failed")
        if action == "reload_prompts":
            self._manager.reload_prompts()
            return {}
        if action == "set_proactive":
            enabled = bool(params.get("enabled", True))
            self._manager.set_proactive(enabled)
            return {"enabled": enabled}
        if action == "set_proactive_idle":
            seconds = int(params.get("seconds", 120))
            self._manager.set_proactive_idle(seconds)
            return {"seconds": seconds}
        if action == "set_screen_vision":
            enabled = bool(params.get("enabled", True))
            self._manager.set_screen_vision(enabled)
            return {"enabled": enabled}
        if action == "set_vision_source":
            source = str(params.get("source", ""))
            enabled = bool(params.get("enabled", True))
            self._manager.set_vision_source(source, enabled)
            return {"source": source, "enabled": enabled}

        raise ManagementFailure(
            "unknown_action",
            f"Unknown management action: {action}",
        )

    @staticmethod
    def _result_or_raise(result: dict, code: str) -> dict:
        if "error" in result:
            raise ManagementFailure(code, str(result["error"]))
        return result
