from fastapi import Response

from app.modules.llm.api import health


def test_llm_health_is_unavailable_without_effective_api_key(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY_ENV", "TEST_LLM_API_KEY")
    monkeypatch.delenv("TEST_LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    response = Response()

    payload = health(response)

    assert response.status_code == 503
    assert payload["ok"] is False
    assert payload["has_api_key"] is False


def test_llm_health_is_ready_with_effective_api_key(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY_ENV", "TEST_LLM_API_KEY")
    monkeypatch.setenv("TEST_LLM_API_KEY", "test-key")
    response = Response()

    payload = health(response)

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["has_api_key"] is True
