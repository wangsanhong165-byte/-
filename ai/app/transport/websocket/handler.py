"""Typed V3 RuntimeEvent ingress for the CharacterTurn pipeline."""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import wave
from typing import Awaitable, Callable

from app.avatar.controller import AvatarController
from app.avatar.events import (
    AvatarComponentChanged,
    AvatarEvent,
    AvatarExpressionChanged,
    AvatarMotionChanged,
    AvatarRequest,
    AvatarStateRestored,
    AvatarSuggestionCreated,
)
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.visual_attachments import (
    VisualAttachmentError,
    VisualAttachmentStore,
    validate_visual_attachment_policy,
)
from app.runtime.visual_context import TurnVisualContext
from app.transport.domain_event import DomainEvent
from app.transport.emitter import TransportEmitter
from contracts.v3.envelope import EventEnvelope, error_envelope
from contracts.v3.events import (
    CharacterControlRequestedPayload,
    CharacterSuggestionAcceptedPayload,
    CharacterSuggestionRejectedPayload,
    ManagementRequestedPayload,
    UserAudioChunkPayload,
    UserAudioCompletedPayload,
    UserAudioStartedPayload,
    UserTextPayload,
    UserVisualPayload,
)

logger = logging.getLogger("transport.handler")

RuntimeResponse = EventEnvelope | DomainEvent
PushEvent = Callable[[RuntimeResponse], Awaitable[None]]


class RuntimeEventHandler:
    """Map typed V3 events to existing domain commands and CharacterTurn."""

    def __init__(
        self,
        runtime=None,
        send_event=None,
        avatar_controller: AvatarController | None = None,
    ):
        if runtime is None:
            from app.runtime.runtime import runtime as default_runtime
            runtime = default_runtime
        self.runtime = runtime
        self.send_event: PushEvent | None = send_event
        self.emitter_factory = TransportEmitter
        self.avatar = avatar_controller
        self._management = None
        self._audio_buffer: list[float] = []
        self._sample_rate = 16000
        self._audio_turn_id = ""
        self._audio_session_id = ""
        self._active_task: asyncio.Task[None] | None = None
        self._active_turn_id = ""
        self._turns_processed = 0

    @property
    def management(self):
        if self._management is None:
            from app.transport.management import ManagementHandler

            self._management = ManagementHandler()
        return self._management

    def enable_proactive_push(self) -> None:
        self.runtime.register_proactive_handler(self._on_proactive_reply)

    def disable_proactive_push(self) -> None:
        self.runtime.unregister_proactive_handler(self._on_proactive_reply)
        self._set_user_input_active(False)
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()

    def _resolve_visual_attachments(self, attachments: list) -> tuple[dict, ...]:
        validate_visual_attachment_policy(count=len(attachments))
        store = VisualAttachmentStore()
        return tuple(
            store.resolve(item.attachment_id).to_public_dict()
            for item in attachments
        )

    def _screen_frame_for_turn(self, source: str) -> tuple[dict, ...]:
        runtime = getattr(self, "runtime", None)
        if runtime is None or not getattr(runtime, f"_{source}_enabled", False):
            return ()
        frame = TurnVisualContext(runtime).screen_frame()
        return (frame,) if frame else ()

    async def handle_event(self, event: EventEnvelope) -> list[RuntimeResponse]:
        event_type = event.event_type

        if event_type == "user.text":
            payload = self._payload(event, UserTextPayload)
            turn_input = TurnInput(
                text=payload.text,
                visual_attachments=self._screen_frame_for_turn("text_screen"),
                session_id=event.session_id,
                turn_id=event.turn_id or "",
            )
            return await self._start_or_run_turn(turn_input)

        if event_type == "user.visual":
            payload = self._payload(event, UserVisualPayload)
            try:
                store = VisualAttachmentStore()
                attachments = tuple(
                    store.resolve(item.attachment_id).to_public_dict()
                    for item in payload.attachments
                )
                visual_attachments = (
                    attachments + self._screen_frame_for_turn("text_screen")
                )
                validate_visual_attachment_policy(count=len(visual_attachments))
            except VisualAttachmentError as exc:
                return [error_envelope(
                    "visual_attachment_invalid",
                    str(exc),
                    session_id=event.session_id,
                    turn_id=event.turn_id or "",
                )]
            return await self._start_or_run_turn(TurnInput(
                text=payload.text,
                visual_attachments=visual_attachments,
                session_id=event.session_id,
                turn_id=event.turn_id or "",
            ))

        if event_type == "user.audio.started":
            payload = self._payload(event, UserAudioStartedPayload)
            if self._active_turn_id and self._active_turn_id != event.turn_id:
                return [self._stale_turn(event)]
            self._audio_buffer.clear()
            self._sample_rate = payload.sample_rate
            self._audio_turn_id = event.turn_id or ""
            self._audio_session_id = event.session_id
            self._active_turn_id = self._audio_turn_id
            self._set_user_input_active(True)
            return []

        if event_type == "user.audio.chunk":
            payload = self._payload(event, UserAudioChunkPayload)
            if not self._matches_audio_turn(event):
                return [self._stale_turn(event)]
            self._audio_buffer.extend(payload.samples)
            return []

        if event_type == "user.audio.completed":
            payload = self._payload(event, UserAudioCompletedPayload)
            if not self._matches_audio_turn(event):
                return [self._stale_turn(event)]
            if payload.sample_rate:
                self._sample_rate = payload.sample_rate
            audio = self._audio_to_wav()
            self._clear_audio()
            if not audio:
                self._set_user_input_active(False)
                return [error_envelope(
                    "empty_audio",
                    "Audio turn completed without samples",
                    session_id=event.session_id,
                    turn_id=event.turn_id or "",
                )]
            try:
                camera_attachments = self._resolve_visual_attachments(
                    payload.attachments
                )
            except VisualAttachmentError as exc:
                self._set_user_input_active(False)
                return [error_envelope(
                    "visual_attachment_invalid",
                    str(exc),
                    session_id=event.session_id,
                    turn_id=event.turn_id or "",
                )]
            visual_attachments = (
                camera_attachments + self._screen_frame_for_turn("voice_screen")
            )
            return await self._start_or_run_turn(TurnInput(
                audio=audio,
                sample_rate=self._sample_rate,
                visual_attachments=visual_attachments,
                session_id=event.session_id,
                turn_id=event.turn_id or "",
            ))

        if event_type in {"user.audio.cancelled", "turn.cancelled"}:
            return await self._cancel_turn(event)

        if event_type == "management.requested":
            payload = self._payload(event, ManagementRequestedPayload)
            return await self.management.handle(
                payload.action,
                payload.params,
                payload.request_id,
            )

        if event_type == "character.control.requested":
            return await self._handle_avatar_request(
                event,
                self._payload(event, CharacterControlRequestedPayload),
            )

        if event_type == "character.suggestion.accepted":
            payload = self._payload(event, CharacterSuggestionAcceptedPayload)
            raw = await self.avatar.handle_accept(payload.suggestion_id) if self.avatar else []
            return self._avatar_responses(event, raw)

        if event_type == "character.suggestion.rejected":
            payload = self._payload(event, CharacterSuggestionRejectedPayload)
            raw = await self.avatar.handle_reject(payload.suggestion_id) if self.avatar else []
            return self._avatar_responses(event, raw)

        return [error_envelope(
            "unsupported_event",
            f"Unsupported runtime event: {event_type}",
            session_id=event.session_id,
            turn_id=event.turn_id or "",
        )]

    @staticmethod
    def _payload(event: EventEnvelope, expected_type):
        payload = event.payload
        if not isinstance(payload, expected_type):
            raise TypeError(
                f"{event.event_type} payload must be {expected_type.__name__}"
            )
        return payload

    async def _start_or_run_turn(self, turn_input: TurnInput) -> list[RuntimeResponse]:
        if self._active_turn_id and self._active_turn_id != turn_input.turn_id:
            return [error_envelope(
                "turn_in_progress",
                f"Turn {self._active_turn_id} is still active",
                session_id=turn_input.session_id,
                turn_id=turn_input.turn_id,
            )]
        self._active_turn_id = turn_input.turn_id
        self._turns_processed += 1

        if self.send_event is not None:
            self._active_task = asyncio.create_task(self._run_turn_and_push(turn_input))
            return []

        try:
            return await self._run_turn(turn_input)
        finally:
            self._active_turn_id = ""
            if turn_input.audio:
                self._set_user_input_active(False)

    async def _run_turn_and_push(self, turn_input: TurnInput) -> None:
        try:
            await self._run_turn(turn_input)
        except asyncio.CancelledError:
            logger.info("Turn cancelled: %s", turn_input.turn_id)
            raise
        except Exception:
            logger.exception("V3 turn task failed: %s", turn_input.turn_id)
        finally:
            if self._active_turn_id == turn_input.turn_id:
                self._active_turn_id = ""
            self._active_task = None
            if turn_input.audio:
                self._set_user_input_active(False)

    async def _run_turn(self, turn_input: TurnInput) -> list[RuntimeResponse]:
        emitter = self.emitter_factory()
        responses: list[RuntimeResponse] = []
        start_events = emitter.start_input(turn_input)
        if self.send_event is not None:
            for event in start_events:
                await self.send_event(event)
        else:
            responses.extend(start_events)

        async def report_status(message):
            event = DomainEvent.create(
                "turn.progress",
                {"stage": "runtime", "message": str(message)},
                turn_id=turn_input.turn_id,
            )
            if self.send_event is not None:
                await self.send_event(event)
            else:
                responses.append(event)

        async def confirm_tool(name, args, risk):
            if self.send_event is None:
                return False
            from app.runtime.tool_confirmation import tool_confirmation_broker

            async def notify(payload):
                await self.send_event(DomainEvent.create(
                    "tool.requested",
                    {
                        "requestId": payload["request_id"],
                        "tool": payload["tool"],
                        "args": payload["args"],
                        "risk": payload["risk"],
                    },
                    turn_id=turn_input.turn_id,
                ))

            return await tool_confirmation_broker.request(notify, name, args, risk)

        turn: CharacterTurn = await self.runtime.handle_turn(
            turn_input,
            status_callback=report_status,
            confirmation_callback=confirm_tool,
        )
        completion = emitter.emit_completion(turn)
        if self.send_event is not None:
            for event in completion:
                await self.send_event(event)
        else:
            responses.extend(completion)
        return responses

    def _matches_audio_turn(self, event: EventEnvelope) -> bool:
        return bool(
            self._audio_turn_id
            and event.turn_id == self._audio_turn_id
            and event.session_id == self._audio_session_id
        )

    def _audio_to_wav(self) -> bytes:
        if not self._audio_buffer:
            return b""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self._sample_rate)
            samples = [
                max(-32768, min(32767, int(sample * 32767)))
                for sample in self._audio_buffer
            ]
            wav_file.writeframes(struct.pack(f"<{len(samples)}h", *samples))
        return buf.getvalue()

    def _clear_audio(self) -> None:
        self._audio_buffer.clear()
        self._audio_turn_id = ""
        self._audio_session_id = ""
        if self._active_task is None:
            self._active_turn_id = ""

    def _set_user_input_active(self, active: bool) -> None:
        setter = getattr(self.runtime, "set_user_input_active", None)
        if callable(setter):
            setter(active)

    async def _cancel_turn(self, event: EventEnvelope) -> list[RuntimeResponse]:
        if self._active_turn_id and event.turn_id != self._active_turn_id:
            return [self._stale_turn(event)]
        self._clear_audio()
        if self._active_task and not self._active_task.done():
            active_task = self._active_task
            active_task.cancel()
            try:
                await active_task
            except asyncio.CancelledError:
                pass
        self._set_user_input_active(False)
        self._active_turn_id = ""
        reason = getattr(event.payload, "reason", "cancelled")
        return [
            DomainEvent.create(
                "tts.cancelled",
                {"reason": reason},
                turn_id=event.turn_id,
            ),
            DomainEvent.create(
                "turn.cancelled",
                {"reason": reason},
                turn_id=event.turn_id,
            ),
        ]

    @staticmethod
    def _stale_turn(event: EventEnvelope) -> EventEnvelope:
        return error_envelope(
            "stale_turn",
            f"Event belongs to inactive turn {event.turn_id}",
            session_id=event.session_id,
            turn_id=event.turn_id or "",
        )

    async def _handle_avatar_request(
        self,
        event: EventEnvelope,
        payload: CharacterControlRequestedPayload,
    ) -> list[RuntimeResponse]:
        if not self.avatar:
            return []
        params = payload.params
        request = AvatarRequest(
            target=str(params.get("target", "")),
            name=str(params.get("name", "")),
            action=payload.action,
            source=str(params.get("source", "user")),
            priority=int(params.get("priority", 100)),
        )
        return self._avatar_responses(event, await self.avatar.handle_request(request))

    def _avatar_responses(
        self,
        request: EventEnvelope,
        messages: list[AvatarEvent],
    ) -> list[RuntimeResponse]:
        results: list[RuntimeResponse] = []
        for message in messages:
            if isinstance(message, AvatarComponentChanged):
                event_type = "character.component"
                payload = {
                    "name": message.name,
                    "enabled": message.enabled,
                    "displayName": message.display_name,
                    "controller": message.controller,
                    "priority": message.priority,
                    "expression": message.expression,
                    "paramIds": message.param_ids,
                }
            elif isinstance(message, AvatarExpressionChanged):
                event_type = "character.expression"
                payload = {
                    "name": message.name,
                    "intensity": message.intensity,
                    "controller": message.controller,
                    "priority": message.priority,
                }
            elif isinstance(message, AvatarMotionChanged):
                event_type = "character.motion"
                payload = {
                    "name": message.name,
                    "controller": message.controller,
                    "priority": message.priority,
                    "loop": message.loop,
                }
            elif isinstance(message, AvatarStateRestored):
                event_type = "character.snapshot"
                payload = {
                    "components": message.components,
                    "expression": message.expression,
                    "expressionIntensity": message.expression_intensity,
                    "motion": message.motion,
                }
            elif isinstance(message, AvatarSuggestionCreated):
                event_type = "character.suggestion"
                payload = {
                    "suggestionId": message.suggestion_id,
                    "target": message.target,
                    "name": message.name,
                    "action": message.action,
                    "reason": message.reason,
                }
            else:
                raise TypeError(
                    f"Unsupported avatar domain event: {type(message).__name__}"
                )
            results.append(DomainEvent.create(
                event_type,
                payload,
                turn_id=request.turn_id,
            ))
        return results

    async def _on_proactive_reply(self, turn: CharacterTurn) -> None:
        if self.send_event is None:
            return
        emitter = self.emitter_factory()
        for event in emitter.emit(turn):
            await self.send_event(event)

    def memory_finalize(self) -> None:
        """Best-effort final memory extraction for the closing session.

        Called from the bridge's WebSocket disconnect path. Only fires when
        this connection actually processed a turn; the extraction itself is a
        background, idempotent no-op when there are no unprocessed turns.
        """
        if self._turns_processed <= 0:
            return
        memory = getattr(self.runtime, "providers", {}).get("memory")
        if memory is not None and hasattr(memory, "on_session_end"):
            memory.on_session_end()
