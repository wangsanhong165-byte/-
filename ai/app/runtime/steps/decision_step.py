"""DecisionStep — thin orchestrator for planner → LLM → tools → response.

Composes: DefaultPlanner → PromptCompiler → LLM.generate → ToolCoordinator → ResponseInterpreter

Extracted to separate services:
  - DefaultPlanner -> app/runtime/default_planner.py
  - ToolCoordinator -> app/runtime/tool_coordinator.py
  - PromptCompiler -> app/runtime/prompt_compiler.py (already separate)
  - ResponseInterpreter -> app/runtime/response_interpreter.py (already separate)
  - ResponseValidator -> app/runtime/response_validator.py (already separate)
  - ToolExecutionSupervisor -> app/runtime/tool_execution.py (already separate)
  - ToolPolicy -> app/runtime/tool_policy.py (already separate)
  - ContextBudget -> app/runtime/context_budget.py (already separate)
"""

import logging
import os
import json as _json
from copy import deepcopy
from typing import Any

logger = logging.getLogger("decision_step")

from app.runtime.pipeline import Step
from app.runtime.character_turn import CharacterTurn
from app.runtime.default_planner import DefaultPlanner, Plan  # compatibility exports
from app.interfaces.llm import LLMInterface, LLMResponse
from app.interfaces.tool import ToolInterface
from app.runtime.tool_coordinator import ToolCoordinator

_MAX_TOOL_ROUNDS = min(3, max(1, int(os.environ.get("AGENT_MAX_TOOL_ROUNDS", "3"))))


def _empty_reply_fallback() -> str:
    """Graceful line when the LLM still returns no text after one repair."""
    return os.environ.get(
        "LLM_EMPTY_REPLY_FALLBACK",
        "我刚才走神了，能再跟我说一遍吗？",
    )


class DecisionStep(Step):
    """Strategy combination: Planner → PromptCompiler → Reasoner.

    Calls the LLM, delegates tool-calling to ToolCoordinator, then produces
    final reply. Adds turns to conversation history.

    Protocol-agnostic: consumes LLMResponse canonical objects.
    No provider detection, no json.loads, no nested parsing.
    """

    def __init__(
        self,
        llm: LLMInterface,
        tool_provider: ToolInterface | None = None,
        planner=None,
        tool_supervisor=None,
    ):
        self.llm = llm
        self.tools = tool_provider
        from app.runtime.prompt_compiler import PromptCompiler
        from app.runtime.response_interpreter import ResponseInterpreter
        self.prompt_compiler = PromptCompiler(planner=planner)
        self.response_interpreter = ResponseInterpreter()
        self.tool_coordinator = ToolCoordinator(
            tools=tool_provider,
            tool_supervisor=tool_supervisor,
            max_rounds=_MAX_TOOL_ROUNDS,
        )

    async def run(self, ctx: CharacterTurn) -> None:
        from app.runtime.response_validator import ResponseValidator, ValidatedResponse
        from app.runtime.tool_policy import ToolPolicy

        compiled = self.prompt_compiler.compile(ctx, ctx.character_self)
        messages = list(compiled.messages)
        ctx.prompt_sources = [str(message.get("_source_id", "")) for message in messages]
        ctx.context_budget = compiled.budget_report
        context_budget = self.prompt_compiler.context_budget

        user_text = ctx.user_text or ctx.event.payload.get("text", "")

        # Resolve tool schemas once, before the loop
        tool_schemas: list[dict] | None = None
        if self.tools is not None:
            try:
                tool_schemas = await self.tools.list_tools()
                tool_schemas = ToolPolicy().filter_schemas(
                    tool_schemas, input_origin=ctx.input_origin
                )
            except Exception:
                logger.warning("Failed to list tools — tool calling disabled")

        # Delegate tool loop to ToolCoordinator
        def _sync_prompt_sources(msgs) -> None:
            resolved: list[str] = []
            for message in msgs:
                role = str(message.get("role", ""))
                known = str(message.get("_source_id", ""))
                if known:
                    resolved.append(known)
                elif role == "tool":
                    resolved.append("tool_result")
                elif role == "assistant":
                    resolved.append("assistant_tool_call")
                elif role == "user":
                    resolved.append("user_input")
                elif role == "system":
                    resolved.append("repair_instruction")
                else:
                    resolved.append(role or "unknown")
            ctx.prompt_sources = resolved

        def _llm_gen(msgs, tools=None):
            _sync_prompt_sources(msgs)
            clean_messages = deepcopy(msgs)
            for message in clean_messages:
                message.pop("_source_id", None)
            ctx.prompt_messages = deepcopy(clean_messages)
            return self.llm.generate(clean_messages, tools=tools)

        messages, response, accumulated_usage, final_reply = await self.tool_coordinator.execute_loop(
            messages, ctx, tool_schemas, context_budget, _llm_gen
        )

        from app.modules.tts_preprocessor import split_reasoning

        safe = ResponseValidator().validate(
            final_reply or response.reply,
            response.segments or [],
            allowed_emotions=ctx.allowed_emotions,
            semantic_context=user_text,
        )
        original_reply = (final_reply or response.reply).strip()
        if not safe.valid:
            truncated = response.finish_reason == "length"
            invalid_content = original_reply
            # An empty assistant message (or a whitespace-only one) is
            # meaningless to the model and some APIs reject it; the repair
            # instruction below carries the context.
            if invalid_content:
                messages.append({
                    "role": "assistant",
                    "content": invalid_content,
                })
            repair_hint = (
                "Your previous response was truncated before a reply was "
                "produced. Return a complete valid JSON object now. Never "
                "return empty content."
                if truncated
                else (
                    "Your previous response was invalid structured output. "
                    "Repair it now. Return only the required valid JSON object; "
                    "preserve the intended meaning and do not call tools. "
                    "final_reply and segment text must contain spoken words only; "
                    "put visible expressions and body actions only in emotion, "
                    "behavior, naturalVAD, and motionPlan. "
                    "Never return empty content."
                )
            )
            messages.append({
                "role": "system",
                "_source_id": "repair_instruction",
                "content": repair_hint,
            })
            _sync_prompt_sources(messages)
            clean_messages = deepcopy(messages)
            for message in clean_messages:
                message.pop("_source_id", None)
            ctx.prompt_messages = deepcopy(clean_messages)
            repair = await self.llm.generate(
                clean_messages, tools=None, temperature=0
            )
            accumulated_usage.add(repair.usage)
            response = repair
            safe = ResponseValidator().validate(
                repair.reply,
                repair.segments or [],
                allowed_emotions=ctx.allowed_emotions,
                semantic_context=user_text,
            )
            if not safe.valid:
                # A structured repair is attempted exactly once.  If it still
                # fails, retain usable prose rather than replacing the spoken
                # answer with a generic line. Prefer the original reply so a
                # failed repair cannot rewrite the user's visible answer.
                repair_reply = str(repair.reply or "").strip()
                fallback_reply = (
                    original_reply
                    if original_reply and not original_reply.lstrip().startswith(("{", "["))
                    else repair_reply
                    if repair_reply and not repair_reply.lstrip().startswith(("{", "["))
                    else ""
                )
                if fallback_reply:
                    recovered = ResponseValidator().validate(
                        fallback_reply,
                        [],
                        allowed_emotions=ctx.allowed_emotions,
                        semantic_context=user_text,
                    )
                    safe = ValidatedResponse(
                        reply=recovered.reply or fallback_reply,
                        segments=recovered.segments,
                        valid=True,
                    )
                    ctx.warnings.append("assistant_reply_semantic_recovered")
                    if recovered.reply != fallback_reply:
                        ctx.warnings.append("assistant_reply_sanitized")
                else:
                    fallback = _empty_reply_fallback()
                    safe = ValidatedResponse(
                        reply=fallback,
                        segments=[{
                            "text": fallback,
                            "emotion": "neutral",
                            "behavior": "speak",
                            "attention": "user",
                            "energy": 0.5,
                            "intensity": 0.5,
                            "contextTags": ["empty_reply_fallback"],
                        }],
                        valid=True,
                    )
                    # Marked so the recovery line is never written into the LLM
                    # conversation history — storing "I got distracted" poisons
                    # later turns and makes the model echo the pattern instead
                    # of answering.
                    ctx.warnings.append("assistant_reply_fallback")
        clean_reply, tagged_reasoning = split_reasoning(safe.reply)
        interpreted = self.response_interpreter.interpret(
            LLMResponse(
                reply=clean_reply,
                reasoning=response.reasoning,
                segments=safe.segments,
                tool_calls=response.tool_calls,
                usage=response.usage,
            ),
            ctx,
        )
        ctx.reply_text = interpreted.reply_text
        ctx.segments = interpreted.segments
        ctx.output.performance = interpreted.performance
        ctx.warnings.extend(interpreted.warnings)
        from app.runtime.usage import usage_report
        ctx.llm_usage = usage_report(accumulated_usage)
        provider_reasoning = (response.reasoning or "").strip()
        ctx.reasoning = "\n\n".join(part for part in (provider_reasoning, tagged_reasoning) if part)

        # Add turns to conversation
        conversation = ctx.conversation
        if conversation is not None:
            if user_text and ctx.input_origin == "user":
                conversation.add_turn("user", user_text)
            if ctx.reply_text and not any(
                warning.startswith("assistant_reply_fallback")
                for warning in ctx.warnings
            ):
                conversation.add_turn("assistant", ctx.reply_text)
