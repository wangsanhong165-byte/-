"""Normalize model presentation output before TTS and memory."""

import re
from collections.abc import Iterable
from dataclasses import dataclass

from app.runtime.character_intent import BEHAVIORS, CharacterIntent


@dataclass
class ValidatedResponse:
    reply: str
    segments: list[dict]
    valid: bool = True


class ResponseValidator:
    def validate(
        self,
        reply: str,
        segments: list[dict] | None,
        *,
        allowed_emotions: Iterable[str] | None = None,
        semantic_context: str = "",
    ) -> ValidatedResponse:
        accepted_emotions = CharacterIntent._accepted_emotions(allowed_emotions)
        raw_reply = str(reply or "")
        spoken_reply, reply_had_stage_direction = self._spoken_text(raw_reply)
        # Spoken text without semantic segments is usable as an availability
        # fallback, but it is not a valid presentation response. Mark even a
        # single sentence invalid so DecisionStep performs its one bounded,
        # tool-free structured repair before accepting the prose fallback.
        missing_structured = bool(spoken_reply and not segments)
        malformed_structured = bool(
            raw_reply and raw_reply.lstrip().startswith(("{", "["))
            and not segments
        )
        normalized = []
        narrated_performance = reply_had_stage_direction
        for raw in segments or []:
            raw_text = str(raw.get("text", "")).strip()
            text, had_stage_direction = self._spoken_text(raw_text)
            narrated_performance = narrated_performance or had_stage_direction
            if not text:
                continue
            emotion = str(raw.get("emotion", "neutral")).lower()
            behavior = str(raw.get("behavior", "speak")).lower()
            if emotion not in accepted_emotions:
                emotion = "neutral"
            if behavior not in BEHAVIORS or behavior == "idle":
                behavior = "speak"
            item = dict(raw)
            item.update({
                "text": text,
                "emotion": emotion,
                "behavior": behavior,
                "energy": self._clamp(raw.get("energy", 0.5)),
                "intensity": self._clamp(raw.get("intensity", 0.5)),
            })
            motion_plan = CharacterIntent._motion_plan(
                raw.get("motionPlan", raw.get("motion_plan"))
            )
            item.pop("motion_plan", None)
            if motion_plan is None:
                item.pop("motionPlan", None)
            else:
                item["motionPlan"] = motion_plan
            normalized.append(item)
        if normalized:
            reply = " ".join(item["text"] for item in normalized)
        elif raw_reply:
            reply = spoken_reply
            if reply:
                if raw_reply.lstrip().startswith(("{", "[")):
                    reply = "I couldn't format that response safely."
                normalized = self._recover_semantic_segments(
                    reply,
                    accepted_emotions,
                    semantic_text=raw_reply,
                    semantic_context=semantic_context,
                )
        # An empty reply (no spoken text and no non-empty segments) is never a
        # legitimate completion for a voice companion: it is either truncation
        # (finish_reason="length", reasoning consumed the budget) or the model
        # silently emitted no content. Mark it invalid so the pipeline repairs
        # it instead of presenting silence as success.
        valid = (
            not malformed_structured
            and not missing_structured
            and not narrated_performance
            and bool(normalized or str(reply or "").strip())
        )
        return ValidatedResponse(
            str(reply or "").strip(), normalized, valid,
        )

    @classmethod
    def _recover_semantic_segments(
        cls,
        reply: str,
        accepted_emotions: set[str] | None = None,
        *,
        semantic_text: str = "",
        semantic_context: str = "",
    ) -> list[dict]:
        """Conservative fallback when a provider drops the JSON envelope.

        The first validation remains invalid so DecisionStep asks the LLM for
        one structured repair. These renderer-independent segments are retained
        only if that repair also fails; no Cubism or model-specific names are
        inferred here.
        """
        sentences = cls._split_sentences(reply)
        if not sentences:
            sentences = [reply]
        semantic_sentences = cls._split_sentences(semantic_text) if semantic_text else []
        if len(semantic_sentences) != len(sentences):
            semantic_sentences = [semantic_text] if len(sentences) == 1 else []
        recovered = [
            cls._recover_sentence(
                sentence,
                "\n".join(filter(None, (
                    semantic_context.strip(),
                    semantic_sentences[index] if semantic_sentences else sentence,
                ))),
            )
            for index, sentence in enumerate(sentences)
        ]
        if accepted_emotions is not None:
            for item in recovered:
                if item["emotion"] not in accepted_emotions:
                    item["emotion"] = cls._supported_emotion(
                        item["emotion"], accepted_emotions,
                    )
        return recovered

    @staticmethod
    def _supported_emotion(emotion: str, accepted_emotions: set[str]) -> str:
        """Collapse semantic aliases onto the model's real visual palette."""
        families = {
            "cry": ("sad",),
            "worried": ("sad",),
            "pout": ("angry",),
            "confused": ("surprised",),
            "embarrassed": ("shy",),
            "joyful": ("happy",),
            "cheerful": ("happy",),
            "laughing": ("happy",),
            "smile": ("happy",),
        }
        for candidate in families.get(emotion, ()):
            if candidate in accepted_emotions:
                return candidate
        return "neutral"

    @staticmethod
    def _split_sentences(reply: str) -> list[str]:
        return [
            match.group(0).strip()
            for match in re.finditer(r"[^。！？!?]+[。！？!?]?", reply)
            if match.group(0).strip()
        ][:6]

    @staticmethod
    def _recover_sentence(text: str, semantic_text: str = "") -> dict:
        lowered = (semantic_text or text).casefold()
        emotion = "neutral"
        behavior = "speak"
        energy = 0.5
        intensity = 0.5

        if any(token in lowered for token in (
            "哭哭", "哭哭脸", "想哭", "哭了", "流泪", "眼泪", "委屈", "泪汪汪",
            "cry", "tearful",
        )):
            emotion, energy, intensity = "cry", 0.28, 0.65
        elif any(token in lowered for token in (
            "撅嘴", "嘟嘴", "不满", "闹别扭", "pout",
        )):
            emotion, energy, intensity = "pout", 0.48, 0.58
        elif any(token in lowered for token in ("生气", "愤怒", "恼火", "angry", "mad")):
            emotion, energy, intensity = "angry", 0.75, 0.68
        elif any(token in lowered for token in (
            "惊讶", "惊喜", "震惊", "吓一跳", "没想到", "surprised", "shocked",
        )):
            emotion, energy, intensity = "surprised", 0.78, 0.72
        elif any(token in lowered for token in (
            "疑惑", "不明白", "没明白", "搞不懂", "困惑", "confused",
        )):
            emotion, energy, intensity = "confused", 0.38, 0.5
        elif any(token in lowered for token in ("害羞", "紧张", "不好意思", "脸红", "shy", "nervous")):
            emotion, energy, intensity = "shy", 0.35, 0.48
        elif any(token in lowered for token in (
            "卖萌", "卖个萌", "眨眼", "眨眨眼", "调皮", "俏皮", "逗你", "逗我", "搞怪",
            "playful", "tease",
        )):
            emotion, energy, intensity = "playful", 0.67, 0.62
        elif any(token in lowered for token in (
            "喜欢你", "爱你", "心动", "很喜欢", "love you",
        )):
            emotion, energy, intensity = "love", 0.58, 0.7
        elif any(token in lowered for token in (
            "太开心", "开心死了", "超开心", "太高兴", "高兴坏了", "太好了",
            "好耶", "欢呼", "庆祝", "兴奋", "激动",
            "overjoyed", "thrilled", "celebrate", "excited",
        )):
            emotion, energy, intensity = "joyful", 0.84, 0.82
        elif any(token in lowered for token in (
            "开心", "高兴", "乐意", "期待", "愉快",
            "happy", "glad",
        )):
            emotion, energy, intensity = "happy", 0.68, 0.62
        elif any(token in lowered for token in ("难过", "伤心", "悲伤", "sad", "sorry to hear")):
            emotion, energy, intensity = "sad", 0.3, 0.55
        elif any(token in lowered for token in (
            "没关系", "慢慢来", "放心", "已经很好", "做得很好", "相信你",
            "it's okay", "take your time", "you can do it",
        )):
            emotion, behavior, energy, intensity = "calm", "comfort", 0.38, 0.52

        if any(token in lowered for token in ("你好", "您好", "嗨", "来啦", "见到你", "hello", "hi ")):
            behavior = "greet"
        elif any(token in lowered for token in ("点点头", "点头", "nod")):
            behavior = "nod"
        elif any(token in lowered for token in ("歪头", "侧着头", "tilt")):
            behavior = "tilt"
        elif any(token in lowered for token in ("耸耸肩", "耸肩", "shrug")):
            behavior = "shrug"
        elif any(token in lowered for token in ("挥挥手", "挥手", "wave")):
            behavior = "wave"
        elif any(token in lowered for token in ("哈哈", "笑出声", "大笑", "laugh")):
            behavior = "laugh"
        elif any(token in lowered for token in ("想一想", "想想", "思考", "think")):
            behavior = "think"
        elif any(token in lowered for token in (
            "没关系", "慢慢来", "放心", "相信你", "安慰", "comfort",
        )):
            behavior = "comfort"
        elif any(token in lowered for token in ("不同意", "不赞同", "反对", "摇头", "disagree")):
            behavior = "disagree"
        elif any(token in lowered for token in ("谢谢", "赞同", "同意", "没错", "thank", "agree")):
            behavior = "agree"

        return {
            "text": text,
            "emotion": emotion,
            "behavior": behavior,
            "attention": "user",
            "energy": energy,
            "intensity": intensity,
            "contextTags": ["semantic_recovery"],
        }

    @staticmethod
    def _spoken_text(value: str) -> tuple[str, bool]:
        """Remove explicit stage directions while preserving spoken content."""
        action_patterns = (
            r"(?:做出|摆出|露出).{0,24}(?:脸|表情|神情|笑|哭)",
            r"(?:眨(?:眨)?眼|凑近|靠近|点(?:点)?头|摇(?:摇)?头|歪头|侧头|低(?:下)?头|抬头|挥(?:挥)?手|耸(?:耸)?肩|看着你)",
            r"(?:哭哭脸|笑眯眯|微笑着?|哭着|哭泣|眼神躲闪)",
            r"(?:拿起|放下|举起).{0,16}(?:麦克风|手)",
            r"^(?:笑|哭|叹气|沉默|脸红)$",
            r"\b(?:blink(?:ing)?|lean(?:ing)?|nod(?:ding)?|shake|tilt(?:ing)?|wave|shrug|smil(?:e|ing))\b",
        )
        pattern = re.compile(
            r"（([^（）]{1,160})）|\(([^()]{1,160})\)|"
            r"【([^【】]{1,160})】|\[([^\[\]]{1,160})\]|\*([^*\n]{1,160})\*"
        )
        removed = False

        def replace(match: re.Match) -> str:
            nonlocal removed
            content = next((group for group in match.groups() if group is not None), "")
            lowered = content.strip().casefold()
            if any(re.search(pattern, lowered) for pattern in action_patterns):
                removed = True
                return ""
            return match.group(0)

        spoken = pattern.sub(replace, str(value or "")).strip()
        # Models sometimes put the same visible performance directly into
        # prose instead of brackets ("我眨眨眼给你看", "装出哭哭脸").  Those
        # clauses must never reach TTS: the renderer performs them through the
        # semantic segment while the character says only the remaining words.
        plain_action_patterns = (
            r"(?:那)?(?:我|咱)(?:这就|现在|再|先|来)?(?:给你)?"
            r"(?:眨(?:眨)?眼|凑近|靠近|点(?:点)?头|摇(?:摇)?头|歪头|侧头|"
            r"低(?:下)?头|抬头|挥(?:挥)?手|耸(?:耸)?肩|笑(?:一)?笑|哭(?:一)?哭)"
            r"[^，。！？!?；;]{0,24}",
            r"(?:装出|摆出|露出|做出)[^，。！？!?；;]{0,36}"
            r"(?:样子|表情|神情|笑脸|哭脸)",
            r"(?:眼角|嘴角|眉眼|眉毛)[^，。！？!?；;]{0,30}"
            r"(?:耷拉(?:着)?|弯起|扬起|垂下|皱起|挑起)",
            r"(?:看好了|你看)(?:，|,)?(?:我|这边)(?:这就|现在)?[^，。！？!?；;]{0,24}"
            r"(?:眨眼|点头|摇头|歪头|笑|哭|表情|样子)",
            r"(?:要不要|我)?(?:再)?(?:给你)?配[^，。！？!?；;]{0,20}(?:声|声音)(?:给你)?",
        )
        for action_pattern in plain_action_patterns:
            spoken, count = re.subn(action_pattern, "", spoken, flags=re.IGNORECASE)
            removed = removed or bool(count)
        spoken = re.sub(r"[ \t]{2,}", " ", spoken)
        spoken = re.sub(r"^[，,。；;~～\s]+", "", spoken)
        spoken = re.sub(r"[，,；;]+\s*(?=[。！？!?])", "", spoken)
        spoken = re.sub(r"[，,；;]{2,}", "，", spoken)
        spoken = re.sub(r"[。]{2,}", "。", spoken)
        spoken = re.sub(r"[！!]{2,}", "！", spoken)
        spoken = re.sub(r"[？?]{2,}", "？", spoken)
        spoken = re.sub(r"\s+([，。！？,.!?])", r"\1", spoken).strip()
        if removed and not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", spoken):
            spoken = "这样可以吗？"
        return spoken, removed

    @staticmethod
    def _clamp(value) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.5
