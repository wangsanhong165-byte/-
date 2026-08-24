from unittest.mock import patch

from app.providers.llm.openai_adapter import OpenAILLMProvider


def test_llm_provider_diagnostics_reports_active_opencode_model(monkeypatch):
    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.setenv("OPENCODE_API_KEY", "test-opencode-key")
    monkeypatch.setenv("OPENCODE_BASE_URL", "https://opencode.example/v1")
    monkeypatch.setenv("OPENCODE_MODEL", "mimo-v2.5-free")

    with patch("openai.OpenAI"):
        diagnostics = OpenAILLMProvider().diagnostics()

    assert diagnostics["status"] == "ready"
    assert diagnostics["engine"] == "opencode"
    assert diagnostics["model"] == "mimo-v2.5-free"
    assert diagnostics["base_url"] == "https://opencode.example/v1"
    assert diagnostics["api_key_configured"] is True
    assert "test-opencode-key" not in str(diagnostics)
