"""
backend/services/gemini_service.py
Google Gemini Vision analysis + image-pair comparison service.

v3 additions:
  • compare_images_with_gemini(img1, img2) — sends both images in one request
    and asks Gemini to return a similarity score + match reasons
  • All existing functionality preserved
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Any

import requests

from config.settings import Config

logger = logging.getLogger(__name__)

# ─── Circuit Breaker ──────────────────────────────────────────────────────────
_cb_failure_count: int   = 0
_cb_open_until:    float = 0.0
_CB_FAILURE_THRESHOLD  = 5
_CB_OPEN_DURATION_SECS = 300

# ─── Prompts ──────────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = (
    "You are an expert at analyzing lost and found items on a college campus. "
    "Analyze item images and return ONLY a JSON object with no markdown fences or extra text."
)

_USER_PROMPT = (
    "Analyze this item image and return ONLY a JSON object with these fields:\n"
    '{\n'
    '  "item_name": "specific name",\n'
    '  "item_type": "general category",\n'
    '  "brand": "brand or null",\n'
    '  "model": "model or null",\n'
    '  "color": "primary color",\n'
    '  "material": "material or null",\n'
    '  "condition": "new|good|fair|damaged",\n'
    '  "visible_text": "any text visible in image",\n'
    '  "distinctive_features": "unique identifiers",\n'
    '  "location_clues": "background clues or null",\n'
    '  "category": "phone|wallet|laptop|bag|id_card|keys|earphones|umbrella|water_bottle|notebook|other",\n'
    '  "tags": ["tag1","tag2","tag3"],\n'
    '  "suggested_title": "concise post title ≤60 chars",\n'
    '  "suggested_description": "2-3 sentence description",\n'
    '  "confidence": "high|medium|low"\n'
    "}\n"
    "Be specific about brands and models when visible. Extract ALL text in the image."
)

_COMPARE_SYSTEM_PROMPT = (
    "You are an expert at comparing lost and found item photos to determine if they show the same item. "
    "Return ONLY a JSON object with no markdown fences."
)

_COMPARE_USER_PROMPT = (
    "I will show you two images of items. Determine if they could be the SAME item.\n"
    "Consider: brand, color, model, size, distinctive markings, condition, and overall appearance.\n"
    "Return ONLY this JSON:\n"
    "{\n"
    '  "same_item_probability": 0.0,\n'  # float 0.0 to 1.0
    '  "confidence": "high|medium|low",\n'
    '  "match_reasons": ["reason1", "reason2"],\n'  # list of matching features
    '  "mismatch_reasons": ["reason1"],\n'  # list of non-matching features
    '  "verdict": "likely_same|possibly_same|unlikely_same|different"\n'
    "}\n"
    "Be strict: minor lighting/angle differences are OK. Brand mismatch or different object type = 0.0."
)


# ─── Public API: single-image analysis ───────────────────────────────────────
def analyze_with_gemini(
    image_bytes: bytes | None = None,
    image_url:   str   | None = None,
) -> dict[str, Any]:
    """Analyse a single item image with Gemini Vision."""
    global _cb_failure_count, _cb_open_until

    if time.time() < _cb_open_until:
        return {"error": "Gemini temporarily disabled (circuit open)"}

    api_key = _get_api_key()
    if not api_key:
        return {"error": "GEMINI_API_KEY not configured"}

    if not image_bytes and image_url:
        try:
            r = requests.get(image_url, timeout=10)
            r.raise_for_status()
            image_bytes = r.content
        except Exception as exc:
            return {"error": f"Could not download image: {exc}"}

    if not image_bytes:
        return {"error": "No image provided"}

    b64  = base64.b64encode(image_bytes).decode()
    mime = _detect_mime(image_bytes)
    url  = _endpoint()

    payload = {
        "system_instruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "contents": [{"parts": [
            {"inline_data": {"mime_type": mime, "data": b64}},
            {"text": _USER_PROMPT},
        ]}],
        "generationConfig": {
            "temperature": Config.GEMINI_TEMPERATURE,
            "topP": 0.8, "topK": 40,
            "maxOutputTokens": Config.GEMINI_MAX_OUTPUT_TOKENS,
        },
    }

    return _call_with_retry(url, payload, parser=_sanitise_single)


# ─── Public API: two-image comparison ────────────────────────────────────────
def compare_images_with_gemini(
    image1_bytes: bytes,
    image2_bytes: bytes,
) -> dict[str, Any]:
    """
    Compare two item images and return a similarity assessment.

    Returns dict with:
        same_item_probability  float 0-1
        confidence             str
        match_reasons          list[str]
        mismatch_reasons       list[str]
        verdict                str
        error                  str (only on failure)
    """
    global _cb_failure_count, _cb_open_until

    if time.time() < _cb_open_until:
        return {"error": "Gemini circuit open", "same_item_probability": 0.0}

    api_key = _get_api_key()
    if not api_key:
        return {"error": "GEMINI_API_KEY not configured", "same_item_probability": 0.0}

    b64_1 = base64.b64encode(image1_bytes).decode()
    b64_2 = base64.b64encode(image2_bytes).decode()
    m1    = _detect_mime(image1_bytes)
    m2    = _detect_mime(image2_bytes)
    url   = _endpoint()

    payload = {
        "system_instruction": {"parts": [{"text": _COMPARE_SYSTEM_PROMPT}]},
        "contents": [{"parts": [
            {"text": "Image 1 (item A):"},
            {"inline_data": {"mime_type": m1, "data": b64_1}},
            {"text": "Image 2 (item B):"},
            {"inline_data": {"mime_type": m2, "data": b64_2}},
            {"text": _COMPARE_USER_PROMPT},
        ]}],
        "generationConfig": {
            "temperature": 0.05,  # very low for deterministic comparison
            "topP": 0.9, "topK": 40,
            "maxOutputTokens": 512,
        },
    }

    return _call_with_retry(url, payload, parser=_sanitise_comparison)


# ─── Private helpers ──────────────────────────────────────────────────────────
def _endpoint() -> str:
    api_key = _get_api_key()
    return (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{Config.GEMINI_MODEL}:generateContent?key={api_key}"
    )


def _call_with_retry(url: str, payload: dict, parser) -> dict[str, Any]:
    """POST to Gemini with retry/backoff; parse raw text with parser callable."""
    global _cb_failure_count, _cb_open_until
    last_error = ""

    for attempt in range(1, Config.GEMINI_MAX_RETRIES + 1):
        try:
            resp = requests.post(url, json=payload, timeout=Config.GEMINI_TIMEOUT_SECONDS)
            resp.raise_for_status()
            raw = (
                resp.json()
                    .get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text", "")
            )
            result = parser(raw)
            _cb_failure_count = 0
            return result

        except requests.exceptions.Timeout:
            last_error = "timeout"
            logger.warning("gemini_timeout attempt=%s", attempt)

        except requests.exceptions.HTTPError as exc:
            status = exc.response.status_code if exc.response else 0
            if status == 429:
                wait = 2 ** attempt
                logger.warning("gemini_rate_limited wait=%s", wait)
                time.sleep(wait)
                last_error = "rate_limited"
                continue
            if status == 400:
                _record_failure()
                return {"error": "Invalid request (400)", "same_item_probability": 0.0}
            last_error = f"http_{status}"
            logger.error("gemini_http_error status=%s attempt=%s", status, attempt)

        except Exception as exc:
            last_error = str(exc)
            logger.error("gemini_unexpected error=%s attempt=%s", exc, attempt)

        if attempt < Config.GEMINI_MAX_RETRIES:
            time.sleep(2 ** attempt)

    _record_failure()
    return {"error": f"Gemini failed after {Config.GEMINI_MAX_RETRIES} attempts: {last_error}",
            "same_item_probability": 0.0}


def _record_failure() -> None:
    global _cb_failure_count, _cb_open_until
    _cb_failure_count += 1
    if _cb_failure_count >= _CB_FAILURE_THRESHOLD:
        _cb_open_until = time.time() + _CB_OPEN_DURATION_SECS
        logger.error("gemini_circuit_opened until=%s", _cb_open_until)
        _cb_failure_count = 0


def _parse_raw_json(raw: str) -> dict:
    """Strip markdown fences and parse JSON."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:] if lines[0].startswith("```") else lines
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        import re
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
        return {"error": "Could not parse Gemini JSON", "raw": text[:300]}


def _sanitise_single(raw: str) -> dict[str, Any]:
    """Parse and sanitise single-image analysis response."""
    data = _parse_raw_json(raw)
    if data.get("error") and "raw" in data:
        return data  # parse failure
    valid_cats = {
        "phone", "wallet", "laptop", "bag", "id_card",
        "keys", "earphones", "umbrella", "water_bottle", "notebook", "other",
    }
    if data.get("category") not in valid_cats:
        data["category"] = _infer_category(data.get("item_type", ""))
    if not isinstance(data.get("tags"), list):
        raw_tags = data.get("tags", "")
        data["tags"] = [t.strip() for t in raw_tags.split(",") if t.strip()] if isinstance(raw_tags, str) else []
    for field in ("item_name", "color", "suggested_title", "suggested_description"):
        if not isinstance(data.get(field), str):
            data[field] = ""
    if data.get("confidence") not in ("high", "medium", "low"):
        data["confidence"] = "medium"
    logger.info("gemini_single_ok category=%s confidence=%s", data.get("category"), data.get("confidence"))
    return data


def _sanitise_comparison(raw: str) -> dict[str, Any]:
    """Parse and sanitise two-image comparison response."""
    data = _parse_raw_json(raw)
    if data.get("error"):
        return {**data, "same_item_probability": 0.0}

    # Clamp probability
    prob = data.get("same_item_probability", 0.0)
    try:
        prob = float(prob)
    except (TypeError, ValueError):
        prob = 0.0
    data["same_item_probability"] = max(0.0, min(1.0, prob))

    # Ensure lists
    for field in ("match_reasons", "mismatch_reasons"):
        if not isinstance(data.get(field), list):
            data[field] = []

    # Ensure verdict
    valid_verdicts = {"likely_same", "possibly_same", "unlikely_same", "different"}
    if data.get("verdict") not in valid_verdicts:
        p = data["same_item_probability"]
        data["verdict"] = (
            "likely_same"    if p >= 0.8 else
            "possibly_same"  if p >= 0.5 else
            "unlikely_same"  if p >= 0.25 else
            "different"
        )

    logger.info(
        "gemini_compare_ok prob=%.2f verdict=%s",
        data["same_item_probability"], data.get("verdict"),
    )
    return data


def _infer_category(item_type: str) -> str:
    t = (item_type or "").lower()
    MAP = {
        "phone":        ["phone","mobile","smartphone","iphone","android"],
        "wallet":       ["wallet","purse","cardholder"],
        "laptop":       ["laptop","macbook","tablet","ipad"],
        "bag":          ["bag","backpack","handbag","satchel"],
        "id_card":      ["id","card","badge","pass"],
        "keys":         ["key","keys","keychain"],
        "earphones":    ["earphone","earbud","headphone","airpod"],
        "umbrella":     ["umbrella","brolly"],
        "water_bottle": ["bottle","flask","thermos","tumbler"],
        "notebook":     ["notebook","diary","journal","book"],
    }
    for cat, kws in MAP.items():
        if any(k in t for k in kws):
            return cat
    return "other"


def _detect_mime(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _get_api_key() -> str:
    try:
        from flask import current_app
        return current_app.config.get("GEMINI_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
    except RuntimeError:
        return os.getenv("GEMINI_API_KEY", "")