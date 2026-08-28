"""LLM providers — registered on import."""
import os

from app.interfaces.llm import LLMInterface, MockLLM, ReplayLLM
from app.providers.registry import provider_registry

# Register mock for testing / development
provider_registry.register(LLMInterface, "mock", MockLLM)
provider_registry.register(LLMInterface, "replay", ReplayLLM)

# Register real provider if a usable config resolves (active provider profile or
# legacy env key); "default" alias otherwise falls back to the mock.
from app.config_manager.llm_providers import resolve_active_llm_config

_runtime_cfg = resolve_active_llm_config()
has_api_key = bool((_runtime_cfg.get("api_key") or "").strip()) or bool(
    os.environ.get("DEEPSEEK_API_KEY")
    or os.environ.get("OPENAI_API_KEY")
    or os.environ.get("OPENCODE_API_KEY")
)
if has_api_key:
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    provider_registry.register(LLMInterface, "openai", OpenAILLMProvider)
    provider_registry.register(LLMInterface, "opencode", OpenAILLMProvider)
    provider_registry.register(LLMInterface, "default", OpenAILLMProvider)
else:
    provider_registry.register(LLMInterface, "default", MockLLM)
