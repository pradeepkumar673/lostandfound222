"""
backend/services/match_service.py
CLIP + Gemini multi-signal matching service.

v3 additions:
  • Gemini visual comparison injected for top-N candidates after initial scoring
    — gives a richer "same_item_probability" signal and populates match_reasons
    with human-readable text from Gemini
  • All existing CLIP / text / category signals preserved
  • Gemini comparison is gated: only runs when images available + score > threshold
  • Config.GEMINI_COMPARE_ENABLED flag (default True) to toggle
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import numpy as np
from PIL import Image
from io import BytesIO

from config.settings import Config

logger = logging.getLogger(__name__)

# ─── Lazy-loaded CLIP ─────────────────────────────────────────────────────────
_clip_model     = None
_clip_processor = None


def _load_clip() -> tuple[Any, Any]:
    global _clip_model, _clip_processor
    if _clip_model is not None:
        return _clip_model, _clip_processor
    try:
        from transformers import CLIPModel, CLIPProcessor
        _clip_processor = CLIPProcessor.from_pretrained(Config.CLIP_MODEL_NAME)
        _clip_model     = CLIPModel.from_pretrained(Config.CLIP_MODEL_NAME)
        _clip_model.eval()
        logger.info("clip_model_loaded model=%s", Config.CLIP_MODEL_NAME)
    except Exception as exc:
        logger.error("clip_load_failed error=%s", exc)
        _clip_model = _clip_processor = None
    return _clip_model, _clip_processor


# ─── Embedding helpers ────────────────────────────────────────────────────────
def get_image_embedding(image_bytes: bytes) -> list[float] | None:
    model, processor = _load_clip()
    if model is None:
        return None
    try:
        import torch
        image  = Image.open(BytesIO(image_bytes)).convert("RGB")
        inputs = processor(images=image, return_tensors="pt")
        with torch.no_grad():
            feats = model.get_image_features(**inputs)
        vec  = feats.numpy()[0]
        norm = np.linalg.norm(vec)
        return (vec / norm).tolist() if norm > 0 else vec.tolist()
    except Exception as exc:
        logger.error("image_embedding_failed error=%s", exc)
        return None


@lru_cache(maxsize=Config.EMBEDDING_LRU_MAXSIZE)
def _cached_text_embedding(text: str) -> tuple[float, ...] | None:
    model, processor = _load_clip()
    if model is None:
        return None
    try:
        import torch
        inputs = processor(text=[text[:77]], return_tensors="pt", truncation=True, padding=True)
        with torch.no_grad():
            feats = model.get_text_features(**inputs)
        vec  = feats.numpy()[0]
        norm = np.linalg.norm(vec)
        result = (vec / norm).tolist() if norm > 0 else vec.tolist()
        return tuple(result)
    except Exception as exc:
        logger.error("text_embedding_failed error=%s", exc)
        return None


def get_text_embedding(text: str) -> list[float] | None:
    result = _cached_text_embedding(text[:200])
    return list(result) if result else None


def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    a = np.array(vec_a, dtype=np.float32)
    b = np.array(vec_b, dtype=np.float32)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.clip(np.dot(a, b) / (na * nb), 0.0, 1.0))


# ─── Main Match Function ──────────────────────────────────────────────────────
def find_matches_for_item(
    item_id:   str,
    threshold: float = Config.MATCH_DISPLAY_THRESHOLD,
    limit:     int   = Config.MATCH_RESULT_LIMIT,
) -> list[dict[str, Any]]:
    """
    Find potential matches for ``item_id``.

    Pipeline:
      1. Pre-filter candidates (same category + limit)
      2. Multi-signal score (category, color, brand, tags, CLIP text)
      3. For top candidates with images: Gemini visual comparison (optional)
      4. Merge signals into final score
      5. Persist matches + return sorted list
    """
    from config.database import get_db
    from bson import ObjectId

    db   = get_db()
    item = db.items.find_one({"_id": ObjectId(item_id)})
    if not item:
        return []

    opposite_type = "found" if item["type"] == "lost" else "lost"

    base_filter: dict[str, Any] = {
        "type":    opposite_type,
        "status":  "active",
        "_id":     {"$ne": ObjectId(item_id)},
        "user_id": {"$ne": item["user_id"]},
    }

    category = item.get("category")
    if category and category != "other":
        same_cat_ids = list(
            db.items.find({**base_filter, "category": category}, {"_id": 1})
              .limit(Config.MATCH_CANDIDATE_LIMIT)
        )
        if len(same_cat_ids) < 30:
            other_ids = list(
                db.items.find(
                    {**base_filter, "_id": {"$nin": [d["_id"] for d in same_cat_ids] + [ObjectId(item_id)]}},
                    {"_id": 1},
                ).limit(Config.MATCH_CANDIDATE_LIMIT - len(same_cat_ids))
            )
            candidate_ids = [d["_id"] for d in same_cat_ids + other_ids]
        else:
            candidate_ids = [d["_id"] for d in same_cat_ids]
    else:
        candidate_ids = [
            d["_id"]
            for d in db.items.find(base_filter, {"_id": 1}).limit(Config.MATCH_CANDIDATE_LIMIT)
        ]

    if not candidate_ids:
        return []

    candidates = list(db.items.find({"_id": {"$in": candidate_ids}}))

    # ── Initial scoring ────────────────────────────────────────────────────
    scored: list[tuple[float, dict, dict]] = []  # (score, highlights, candidate)
    for candidate in candidates:
        score, highlights = _compute_match_score(item, candidate)
        if score >= threshold * 0.7:  # loose pre-filter before Gemini
            scored.append((score, highlights, candidate))

    scored.sort(key=lambda x: x[0], reverse=True)

    # ── Gemini visual comparison for top-N candidates ──────────────────────
    gemini_enabled = getattr(Config, "GEMINI_COMPARE_ENABLED", True)
    gemini_top_n   = getattr(Config, "GEMINI_COMPARE_TOP_N", 5)

    if gemini_enabled and item.get("images"):
        scored = _enrich_with_gemini(db, item, scored, top_n=gemini_top_n)

    # ── Final filtering + persist ──────────────────────────────────────────
    matches: list[dict[str, Any]] = []
    for score, highlights, candidate in scored:
        if score < threshold:
            continue
        cand_id = str(candidate["_id"])
        match_doc = {
            "lost_item_id":  item_id  if item["type"] == "lost"  else cand_id,
            "found_item_id": cand_id  if item["type"] == "lost"  else item_id,
            "score":         score,
            "highlights":    highlights,
            "created_at":    datetime.now(timezone.utc),
            "updated_at":    datetime.now(timezone.utc),
        }
        db.matches.update_one(
            {"lost_item_id": match_doc["lost_item_id"], "found_item_id": match_doc["found_item_id"]},
            {"$set": match_doc},
            upsert=True,
        )
        matches.append({
            "item_id":    cand_id,
            "score":      round(score, 4),
            "score_pct":  round(score * 100),
            "highlights": highlights,
            "item": {
                "id":            cand_id,
                "title":         candidate["title"],
                "type":          candidate["type"],
                "category":      candidate.get("category"),
                "location_name": candidate.get("location_name"),
                "date_occurred": (
                    candidate["date_occurred"].isoformat()
                    if candidate.get("date_occurred") else None
                ),
                "thumbnail": candidate["images"][0]["url"] if candidate.get("images") else None,
                "color":     candidate.get("color"),
                "brand":     candidate.get("brand"),
                "tags":      candidate.get("tags", []),
            },
        })

    matches.sort(key=lambda x: x["score"], reverse=True)
    db.items.update_one({"_id": ObjectId(item_id)}, {"$set": {"match_count": len(matches)}})
    return matches[:limit]


# ─── Gemini visual enrichment ─────────────────────────────────────────────────
def _enrich_with_gemini(
    db,
    item: dict,
    scored: list[tuple[float, dict, dict]],
    top_n: int = 5,
) -> list[tuple[float, dict, dict]]:
    """
    For the top-N candidates that have images, call Gemini to compare them
    visually against the source item. Blends the Gemini probability into the
    existing score and adds match_reasons / mismatch_reasons to highlights.
    """
    import requests as req_lib
    from services.gemini_service import compare_images_with_gemini

    # Fetch source item's first image bytes
    item_img_bytes: bytes | None = None
    if item.get("images"):
        url = item["images"][0].get("url")
        if url:
            try:
                r = req_lib.get(url, timeout=8)
                if r.ok:
                    item_img_bytes = r.content
            except Exception as e:
                logger.warning("gemini_enrich: failed to fetch item image url=%s error=%s", url, e)

    if not item_img_bytes:
        return scored  # can't compare without source image

    enriched: list[tuple[float, dict, dict]] = []

    for idx, (score, highlights, candidate) in enumerate(scored):
        if idx >= top_n or not candidate.get("images"):
            enriched.append((score, highlights, candidate))
            continue

        cand_url = candidate["images"][0].get("url")
        if not cand_url:
            enriched.append((score, highlights, candidate))
            continue

        try:
            r = req_lib.get(cand_url, timeout=8)
            if not r.ok:
                raise IOError(f"HTTP {r.status_code}")
            cand_img_bytes = r.content

            gemini_result = compare_images_with_gemini(item_img_bytes, cand_img_bytes)

            if not gemini_result.get("error"):
                gemini_prob = gemini_result.get("same_item_probability", 0.0)

                # Blend: 60% existing score, 40% Gemini visual signal
                GEMINI_WEIGHT = 0.40
                blended_score = (score * (1 - GEMINI_WEIGHT)) + (gemini_prob * GEMINI_WEIGHT)

                # Update highlights with Gemini reasons
                highlights = dict(highlights)
                highlights["gemini_visual_score"]    = round(gemini_prob, 3)
                highlights["gemini_verdict"]         = gemini_result.get("verdict", "")
                highlights["gemini_match_reasons"]   = gemini_result.get("match_reasons", [])
                highlights["gemini_mismatch_reasons"] = gemini_result.get("mismatch_reasons", [])

                logger.info(
                    "gemini_enrich item=%s cand=%s prob=%.2f blended=%.2f",
                    str(item.get("_id", "")), str(candidate.get("_id", "")),
                    gemini_prob, blended_score,
                )
                enriched.append((blended_score, highlights, candidate))
            else:
                logger.warning("gemini_compare_error: %s", gemini_result.get("error"))
                enriched.append((score, highlights, candidate))

        except Exception as e:
            logger.warning("gemini_enrich_failed cand_url=%s error=%s", cand_url, e)
            enriched.append((score, highlights, candidate))

    # Re-sort after blending
    enriched.sort(key=lambda x: x[0], reverse=True)
    return enriched


# ─── CLIP visual search (unchanged) ──────────────────────────────────────────
def search_by_image_embedding(
    image_bytes: bytes,
    limit:       int = Config.MATCH_RESULT_LIMIT,
) -> list[dict[str, Any]]:
    from config.database import get_db
    db        = get_db()
    query_emb = get_image_embedding(image_bytes)

    if query_emb is None:
        items = list(db.items.find({"status": "active"}).sort("created_at", -1).limit(limit))
        return [{"item_id": str(i["_id"]), "score": 0, "score_pct": 0, "title": i["title"]} for i in items]

    items_with_emb = list(
        db.items.find(
            {"status": "active", "image_embedding": {"$exists": True}},
            {"title": 1, "type": 1, "category": 1, "images": 1, "image_embedding": 1},
        ).limit(500)
    )

    results: list[dict] = []
    for item in items_with_emb:
        stored_emb = item.get("image_embedding")
        if stored_emb:
            sim = cosine_similarity(query_emb, stored_emb)
            if sim > 0.3:
                results.append({
                    "item_id":   str(item["_id"]),
                    "score":     round(sim, 4),
                    "score_pct": round(sim * 100),
                    "title":     item.get("title"),
                    "type":      item.get("type"),
                    "category":  item.get("category"),
                    "thumbnail": item["images"][0]["url"] if item.get("images") else None,
                })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]


# ─── Scoring ──────────────────────────────────────────────────────────────────
def _compute_match_score(
    item_a: dict[str, Any],
    item_b: dict[str, Any],
) -> tuple[float, dict[str, Any]]:
    """
    Multi-signal similarity score.
    Weights (from Config):
        category  : 0.30
        color     : 0.15
        brand     : 0.20
        tags      : 0.15
        text (CLIP): 0.20
    """
    highlights: dict[str, Any] = {
        "category_match": False,
        "color_match":    False,
        "brand_match":    False,
        "tag_matches":    [],
        "text_score":     0.0,
    }
    score        = 0.0
    weight_total = 0.0

    # Category
    w = Config.MATCH_WEIGHT_CATEGORY; weight_total += w
    cat_a, cat_b = item_a.get("category"), item_b.get("category")
    if cat_a and cat_b and cat_a == cat_b and cat_a != "other":
        score += w; highlights["category_match"] = True
    elif cat_a and cat_b:
        score += w * 0.2

    # Color
    w = Config.MATCH_WEIGHT_COLOR; weight_total += w
    col_a = (item_a.get("color") or "").lower().strip()
    col_b = (item_b.get("color") or "").lower().strip()
    if col_a and col_b:
        if col_a == col_b:
            score += w; highlights["color_match"] = True
        elif col_a in col_b or col_b in col_a:
            score += w * 0.6; highlights["color_match"] = True

    # Brand
    w = Config.MATCH_WEIGHT_BRAND; weight_total += w
    br_a = (item_a.get("brand") or "").lower().strip()
    br_b = (item_b.get("brand") or "").lower().strip()
    if br_a and br_b and br_a not in ("unknown", "n/a"):
        if br_a == br_b:
            score += w; highlights["brand_match"] = True
        elif br_a in br_b or br_b in br_a:
            score += w * 0.7; highlights["brand_match"] = True

    # Tags
    w = Config.MATCH_WEIGHT_TAGS; weight_total += w
    tags_a = {t.lower() for t in (item_a.get("tags") or [])}
    tags_b = {t.lower() for t in (item_b.get("tags") or [])}
    if tags_a and tags_b:
        common = tags_a & tags_b
        highlights["tag_matches"] = list(common)
        score += w * (len(common) / max(len(tags_a), len(tags_b)))

    # Text CLIP
    w = Config.MATCH_WEIGHT_TEXT; weight_total += w

    def _text(i: dict) -> str:
        return " ".join(filter(None, [
            i.get("title"), i.get("description"), i.get("brand"), i.get("color")
        ]))[:200]

    emb_a = item_a.get("text_embedding") or get_text_embedding(_text(item_a))
    emb_b = item_b.get("text_embedding") or get_text_embedding(_text(item_b))
    if emb_a and emb_b:
        raw_sim = cosine_similarity(list(emb_a), list(emb_b))
        lo, hi  = Config.CLIP_SIM_LOW, Config.CLIP_SIM_HIGH
        normed  = max(0.0, (raw_sim - lo) / max(hi - lo, 1e-6))
        score  += w * normed
        highlights["text_score"] = round(raw_sim, 3)

    final = score / max(weight_total, 1e-9)
    return float(np.clip(final, 0.0, 1.0)), highlights