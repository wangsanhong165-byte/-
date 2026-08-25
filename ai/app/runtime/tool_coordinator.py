"""ToolCoordinator — orchestrates the LLM <-> tool calling loop.

Extracted from DecisionStep to separate tool orchestration from prompt construction.
"""

from __future__ import annotations

import json as _json
import logging
from typing import Any

from app.interfaces.llm import LLMResponse, LLMUsage
from app.interfaces.tool import ToolInterface
from app.runtime.character_turn import CharacterTurn
from app.runtime.tool_execution import ToolExecutionSupervisor
from app.runtime.tool_policy import ToolPolicy
from app.runtime.context_budget import ContextBudget

logger = logging.getLogger("tool_coordinator")

_MAX_TOOL_ROUNDS = 3


class ToolCoordinator:
    """Executes the tool-calling loop: LLM -> tools -> LLM -> ... -> final.

    Delegates tool execution to ToolExecutionSupervisor and schema filtering
    to ToolPolicy. Returns the final (messages, response, usage, audits).
    """

    def __init__(
        self,
        tools: ToolInterface | None = None,
        tool_supervisor: ToolExecutionSupervisor | None = None,
        max_rounds: int = _MAX_TOOL_ROUNDS,
    ):
        self.tools = tools
        self.tool_supervisor = tool_supervisor or ToolExecutionSupervisor()
        self.max_rounds = max_rounds

    async def execute_loop(
        self,
        messages: list[dict],
        ctx: CharacterTurn,
        tool_schemas: list[dict] | None,
        context_budget: ContextBudget,
        llm_generate,
    ) -> tuple[list[dict], LLMResponse, LLMUsage, str]:
        """Run the tool loop. Returns (messages, response, usage, final_reply).

        Args:
            messages: The full message list (mutated in-place with tool results).
            ctx: Turn context for audit tracking.
            tool_schemas: Tool function schemas from list_tools().
            context_budget: Budget tracker for token limits.
            llm_generate: Async callable(llm, messages, tools) -> LLMResponse.
        """
        response = LLMResponse()
        accumulated_usage = LLMUsage()
        final_reply = ""

        for tool_round in range(self.max_rounds):
            messages, round_budget = context_budget.fit_messages(messages)
            ctx.context_budget = round_budget
            response = await llm_generate(messages, tools=tool_schemas)
            accumulated_usage.add(response.usage)

            if response.error:
                final_reply = response.reply or ""
                break

            if not response.tool_calls:
                final_reply = response.reply
                break

            if self.tools is None:
                final_reply = response.reply
                break

            # Append assistant message with tool_calls
            if response.messages:
                carried: list[dict] = []
                for index, response_message in enumerate(response.messages):
                    message = dict(response_message)
                    if index < len(messages) and messages[index].get("_source_id"):
                        message["_source_id"] = messages[index]["_source_id"]
                    elif message.get("role") == "assistant":
                        message["_source_id"] = "assistant_tool_call"
                    carried.append(message)
                messages = carried
            else:
                assistant_msg = {
                    "role": "assistant",
                    "content": response.reply,
                    "_source_id": "assistant_tool_call",
                }
                tc_formatted = []
                for i, tc in enumerate(response.tool_calls):
                    tc_formatted.append({
                        "id": f"call_{tool_round}_{i}",
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": _json.dumps(tc.args, ensure_ascii=False),
                        },
                    })
                if tc_formatted:
                    assistant_msg["tool_calls"] = tc_formatted
                messages.append(assistant_msg)

            real_tool_call_ids: list[str] = []
            if response.messages:
                last_msg = response.messages[-1]
                if last_msg.get("role") == "assistant" and "tool_calls" in last_msg:
                    real_tool_call_ids = [tc.get("id", "") for tc in last_msg["tool_calls"]]

            # Execute and append results
            for i, tc in enumerate(response.tool_calls):
                await self._execute_one_tool(ctx, messages, tool_schemas, tc, i, tool_round, real_tool_call_ids)

            ctx.tool_calls.extend({"name": tc.name, "args": tc.args} for tc in response.tool_calls)
            ctx.tool_results.append({
                "round": tool_round + 1,
                "tool_calls": [{"name": tc.name, "args": tc.args} for tc in response.tool_calls],
            })

        # Budget exhausted fallback
        if not final_reply and response.tool_calls:
            messages.append({
                "role": "system",
                "_source_id": "tool_budget_instruction",
                "content": (
                    "The tool-call budget is exhausted. Do not call more tools. "
                    "Use the available tool results to produce the final structured response now."
                ),
            })
            messages, round_budget = context_budget.fit_messages(messages)
            ctx.context_budget = round_budget
            response = await llm_generate(messages, tools=None)
            accumulated_usage.add(response.usage)
            final_reply = response.reply

        return messages, response, accumulated_usage, final_reply

    async def _execute_one_tool(
        self,
        ctx: CharacterTurn,
        messages: list[dict],
        tool_schemas: list[dict] | None,
        tc: Any,
        idx: int,
        tool_round: int,
        real_tool_call_ids: list[str],
    ) -> None:
        """Execute a single tool call and append its result to messages."""
        tc_name = tc.name
        tc_args = tc.args

        ctx.status_message = f"Executing tool: {tc_name}"
        if callable(ctx.status_callback):
            await ctx.status_callback(ctx.status_message)

        schema_by_name = {
            item.get("function", {}).get("name", ""): item
            for item in (tool_schemas or [])
        }
        policy = ToolPolicy()
        risk = policy.risk_for(schema_by_name.get(tc_name))
        approved = risk == "read_only"
        if risk != "read_only" and callable(ctx.confirmation_callback):
            approved = await ctx.confirmation_callback(tc_name, tc_args, risk)
        if approved:
            execution = await self.tool_supervisor.execute(self.tools, tc_name, tc_args, risk)
            result_text = execution.text
            ctx.tool_audit.append(execution.audit)
        else:
            result_text = (
                '{"error":"confirmation_denied_or_required",'
                f'"tool":"{tc_name}","risk":"{risk}"}}'
            )
            ctx.tool_audit.append({
                "tool": tc_name, "risk": risk, "status": "denied",
                "attempts": 0, "duration_ms": 0,
                "argument_keys": sorted(str(key) for key in tc_args),
            })
        raw_result_text = result_text
        try:
            raw_parsed = _json.loads(raw_result_text)
        except (_json.JSONDecodeError, ValueError, TypeError):
            raw_parsed = None
        result_text = policy.clean_result(result_text)
        from app.runtime.context_budget import ContextBudget
        budget = ContextBudget()
        result_text, tool_budget = budget.fit_tool_result(result_text)
        ctx.tool_result_budgets.append(tool_budget)

        tc_content: str | list = result_text
        try:
            parsed = raw_parsed
            if isinstance(parsed, dict) and parsed.get("type") == "screenshot":
                from app.runtime.visual_attachments import VisualAttachmentError, VisualAttachmentStore

                ctx.visual_diagnostics.update({
                    "hasVisionInput": True,
                    "protocol": "screen_capture",
                    "screenshotToolSuccess": True,
                    "tool": "screen_capture",
                    "toolResultType": "screenshot",
                })
                attachment_id = str(parsed.get("attachmentId", ""))
                try:
                    image_url = VisualAttachmentStore().load_data_url(attachment_id)
                except VisualAttachmentError as exc:
                    ctx.visual_diagnostics.update({
                        "screenshotInjected": False,
                        "screenshotInjectionFailed": str(exc),
                    })
                    tc_content = _json.dumps({
                        "error": "screenshot_injection_failed",
                        "message": str(exc),
                    }, ensure_ascii=False)
                else:
                    ctx.visual_diagnostics.update({
                        "screenshotInjected": True,
                        "imageCount": 1,
                        "imageBytes": int(parsed.get("sizeBytes", 0) or 0),
                        "mimeTypes": [str(parsed.get("mimeType", "image/png"))],
                        "dimensions": [{
                            "width": int(parsed.get("width", 0) or 0),
                            "height": int(parsed.get("height", 0) or 0),
                        }],
                    })
                    tc_content = [
                        {
                            "type": "text",
                            "text": f"Screenshot captured ({parsed.get('width', 0)}x{parsed.get('height', 0)}). Inspect the attached image.",
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": image_url, "detail": "auto"},
                        },
                    ]
            elif isinstance(parsed, dict) and parsed.get("type") == "screenshot_error":
                ctx.visual_diagnostics.update({
                    "hasVisionInput": True,
                    "protocol": "screen_capture",
                    "screenshotToolSuccess": False,
                    "screenshotInjected": False,
                    "visualError": str(parsed.get("error", "screen capture failed")),
                })
        except (_json.JSONDecodeError, ValueError, TypeError):
            pass

        tc_id = real_tool_call_ids[idx] if idx < len(real_tool_call_ids) else f"call_{tool_round}_{idx}"
        messages.append({
            "role": "tool",
            "_source_id": "tool_result",
            "tool_call_id": tc_id,
            "content": tc_content,
        })
