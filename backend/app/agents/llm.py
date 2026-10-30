"""LangChain text chat for DeepSeek-compatible providers and vision transport.

If MODEL_API_KEY is unset, no model output is fabricated: callers get
provider="rule" and deterministic text. LLM text is only ever explanation;
numbers always come from the services layer.
"""
from collections.abc import Iterator
from urllib.parse import urlparse

import httpx
from langchain_openai import ChatOpenAI

from app.core import config


def provider_available() -> bool:
    return bool(config.MODEL_API_KEY)


def provider_name() -> str:
    """对外统一口径：有 key 为 "llm"，无 key 为 "rule"。"""
    return "llm" if provider_available() else "rule"


def _post_chat_completions(payload: dict, timeout: float) -> dict:
    url = config.MODEL_BASE_URL.rstrip("/") + "/chat/completions"
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            url,
            headers={"Authorization": f"Bearer {config.MODEL_API_KEY}"},
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


def _chat_model(timeout: float, thinking: bool | None, *, temperature: float | None = None,
                max_tokens: int | None = None) -> ChatOpenAI:
    if not config.MODEL_API_KEY:
        raise RuntimeError("MODEL_API_KEY 未配置")
    extra_body = {}
    if max_tokens is not None:
        # DeepSeek-compatible endpoints accept max_tokens.
        extra_body["max_tokens"] = max_tokens
    if thinking is not None and thinking_available():
        extra_body["thinking"] = {"type": "enabled" if thinking else "disabled"}
    return ChatOpenAI(
        model=config.MODEL_NAME, base_url=config.MODEL_BASE_URL,
        api_key=config.MODEL_API_KEY, temperature=temperature, timeout=timeout,
        max_retries=0, use_responses_api=False, stream_usage=False, extra_body=extra_body,
    )


def chat_complete(messages: list[dict], timeout: float = 30.0, temperature: float = 0.3,
                  *, max_tokens: int | None = None, thinking: bool | None = None,
                  json_output: bool = False) -> dict:
    """Returns {provider, model, text} or raises on upstream failure."""
    model = _chat_model(timeout, thinking, temperature=temperature, max_tokens=max_tokens)
    options = {"response_format": {"type": "json_object"}} if json_output else {}
    reply = model.invoke(messages, **options)
    return {"provider": "deepseek", "model": config.MODEL_NAME, "text": str(reply.text)}


def thinking_available() -> bool:
    base = urlparse(config.MODEL_BASE_URL)
    return (provider_available() and base.scheme == "https" and base.hostname == "api.deepseek.com"
            and config.MODEL_NAME in {"deepseek-flash", "deepseek-v4-pro"})


def stream_chat(messages: list[dict], timeout: float = 30.0, *, thinking: bool | None = None) -> Iterator[str]:
    finished = False
    for chunk in _chat_model(timeout, thinking).stream(messages):
        if chunk.response_metadata.get("finish_reason"):
            finished = True
        if chunk.text:
            yield str(chunk.text)
    if not finished:
        raise RuntimeError("Provider stream ended before completion")


def vision_chat_complete(image_base64: str, media_type: str, prompt: str,
                         model: str | None = None, timeout: float = 60.0) -> dict:
    """Vision call: returns {provider, model, text} or raises on upstream failure.

    Model resolution: explicit arg > MODEL_VISION_NAME > MODEL_NAME.
    Requests JSON output; if the upstream rejects response_format with 400,
    retries once without it. Timeout / 429 / 4xx / 5xx are raised to the
    caller — never swallowed, never fabricated.
    """
    if not config.MODEL_API_KEY:
        raise RuntimeError("MODEL_API_KEY 未配置")
    resolved = model or getattr(config, "MODEL_VISION_NAME", "") or config.MODEL_NAME
    messages = [
        {"role": "system", "content": "你是一个食材与菜品识别助手。只根据图片内容回答，只返回 JSON，不要输出任何其他文字。"},
        {"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_base64}"}},
        ]},
    ]
    payload = {"model": resolved, "messages": messages, "temperature": 0.0,
               "response_format": {"type": "json_object"}}
    try:
        data = _post_chat_completions(payload, timeout)
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 400:
            # 上游不支持 response_format：去掉它重试一次。
            payload = {k: v for k, v in payload.items() if k != "response_format"}
            data = _post_chat_completions(payload, timeout)
        else:
            raise
    text = data["choices"][0]["message"]["content"]
    return {"provider": "llm", "model": resolved, "text": text}
