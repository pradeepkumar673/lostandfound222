"""
backend/routes/ai.py
CampusLostFound - AI Routes

POST /api/ai/analyze-gemini     - Analyze image with Google Gemini Vision
POST /api/ai/categorize         - Classify image with MobileNetV2
POST /api/ai/ocr                - Extract text via pytesseract
POST /api/ai/search-by-image    - CLIP-based visual search
POST /api/ai/full-analysis      - Combined pipeline (Gemini + OCR + category)
POST /api/ai/compare-images     - Gemini visual comparison of two images (NEW)
GET  /api/ai/categories         - List available categories
"""

from __future__ import annotations

import base64
import io
import logging

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from services.gemini_service import analyze_with_gemini, compare_images_with_gemini
from services.ml_service import categorize_image, extract_ocr_text
from services.match_service import search_by_image_embedding
from config.database import get_db
from utils.helpers import serialize_doc

logger = logging.getLogger(__name__)
ai_bp  = Blueprint("ai", __name__)

CATEGORIES = [
    {"id": "phone",        "label": "Phone / Mobile",      "icon": "📱"},
    {"id": "wallet",       "label": "Wallet / Purse",      "icon": "👛"},
    {"id": "laptop",       "label": "Laptop / Tablet",     "icon": "💻"},
    {"id": "bag",          "label": "Bag / Backpack",      "icon": "🎒"},
    {"id": "id_card",      "label": "ID / Access Card",    "icon": "🪪"},
    {"id": "keys",         "label": "Keys / Keychain",     "icon": "🔑"},
    {"id": "earphones",    "label": "Earphones / AirPods", "icon": "🎧"},
    {"id": "umbrella",     "label": "Umbrella",            "icon": "☂️"},
    {"id": "water_bottle", "label": "Water Bottle",        "icon": "🍶"},
    {"id": "notebook",     "label": "Notebook / Diary",    "icon": "📓"},
    {"id": "other",        "label": "Other",               "icon": "📦"},
]


# ─── GET categories ───────────────────────────────────────────────────────────
@ai_bp.route("/categories", methods=["GET"])
def get_categories():
    return jsonify({"categories": CATEGORIES}), 200


# ─── Gemini single-image analysis ────────────────────────────────────────────
@ai_bp.route("/analyze-gemini", methods=["POST"])
@jwt_required()
def analyze_gemini():
    image_bytes = None
    image_url   = None

    if request.files.get("image"):
        image_bytes = request.files["image"].read()
    elif request.is_json:
        data = request.get_json()
        if data.get("image_base64"):
            try:
                image_bytes = base64.b64decode(data["image_base64"])
            except Exception:
                return jsonify({"error": "Invalid base64 image data"}), 400
        elif data.get("image_url"):
            image_url = data["image_url"]
        else:
            return jsonify({"error": "Provide image file, image_base64, or image_url"}), 400
    else:
        return jsonify({"error": "No image provided"}), 400

    result = analyze_with_gemini(image_bytes=image_bytes, image_url=image_url)

    if result.get("error"):
        logger.warning("Gemini failed, falling back: %s", result["error"])
        fallback = _run_fallback_analysis(image_bytes)
        return jsonify({"source": "fallback", "analysis": fallback,
                        "warning": "Gemini unavailable — used local AI fallback"}), 200

    return jsonify({"source": "gemini", "analysis": result}), 200


# ─── MobileNetV2 categorization ──────────────────────────────────────────────
@ai_bp.route("/categorize", methods=["POST"])
@jwt_required()
def categorize():
    if not request.files.get("image"):
        return jsonify({"error": "Image file required"}), 400
    result = categorize_image(request.files["image"].read())
    return jsonify(result), 200


# ─── OCR ─────────────────────────────────────────────────────────────────────
@ai_bp.route("/ocr", methods=["POST"])
@jwt_required()
def ocr():
    if not request.files.get("image"):
        return jsonify({"error": "Image file required"}), 400
    result = extract_ocr_text(request.files["image"].read())
    return jsonify(result), 200


# ─── CLIP visual search ───────────────────────────────────────────────────────
@ai_bp.route("/search-by-image", methods=["POST"])
@jwt_required()
def search_by_image():
    if not request.files.get("image"):
        return jsonify({"error": "Image file required"}), 400
    matches = search_by_image_embedding(request.files["image"].read())
    return jsonify({"matches": matches, "count": len(matches)}), 200


# ─── Full pipeline (used by NewItemPage) ─────────────────────────────────────
# FIX: this endpoint must accept field name 'image' (singular) — frontend fixed too
@ai_bp.route("/full-analysis", methods=["POST"])
@jwt_required()
def full_analysis():
    """
    Run complete analysis pipeline on a single uploaded image:
      1. Gemini Vision (primary)
      2. MobileNetV2 categorization
      3. OCR text extraction
      4. Return combined dict for form auto-fill

    Accepts: multipart/form-data with field 'image' (singular).
    """
    if not request.files.get("image"):
        return jsonify({"error": "Image file required (field name: 'image')"}), 400

    image_bytes = request.files["image"].read()
    response = {"gemini": None, "category": None, "ocr": None, "source": "pipeline", "combined": {}}

    # 1. Gemini
    gemini_result = analyze_with_gemini(image_bytes=image_bytes)
    if not gemini_result.get("error"):
        response["gemini"] = gemini_result
        response["source"] = "gemini"

    # 2. MobileNetV2
    try:
        response["category"] = categorize_image(image_bytes)
    except Exception as e:
        logger.warning("Categorization failed: %s", e)

    # 3. OCR
    try:
        response["ocr"] = extract_ocr_text(image_bytes)
    except Exception as e:
        logger.warning("OCR failed: %s", e)

    # 4. Combine for form auto-fill
    combined: dict = {}
    if response["gemini"]:
        g = response["gemini"]
        combined.update({
            "title":       g.get("suggested_title", ""),
            "description": g.get("suggested_description", ""),
            "category":    g.get("category", "other"),
            "brand":       g.get("brand", ""),
            "color":       g.get("color", ""),
            "features":    g.get("distinctive_features", ""),
            "tags":        g.get("tags", []),
        })
    elif response["category"]:
        combined["category"] = response["category"].get("category", "other")

    if response["ocr"] and response["ocr"].get("extracted_fields"):
        fields = response["ocr"]["extracted_fields"]
        if fields.get("name") and not combined.get("features"):
            combined["features"] = f"Name visible: {fields['name']}"

    response["combined"] = combined
    return jsonify(response), 200


# ─── NEW: Gemini image comparison ────────────────────────────────────────────
@ai_bp.route("/compare-images", methods=["POST"])
@jwt_required()
def compare_images():
    """
    Compare two item images using Gemini Vision to assess if they show the same item.

    Accepts: multipart/form-data with fields 'image1' and 'image2'.
    Returns:
        {
          "same_item_probability": 0.0–1.0,
          "confidence": "high|medium|low",
          "match_reasons": [...],
          "mismatch_reasons": [...],
          "verdict": "likely_same|possibly_same|unlikely_same|different"
        }
    """
    if not request.files.get("image1") or not request.files.get("image2"):
        return jsonify({"error": "Both 'image1' and 'image2' files are required"}), 400

    img1 = request.files["image1"].read()
    img2 = request.files["image2"].read()

    if not img1 or not img2:
        return jsonify({"error": "Both images must be non-empty"}), 400

    result = compare_images_with_gemini(img1, img2)

    if result.get("error"):
        logger.warning("Gemini compare failed: %s", result["error"])
        return jsonify({
            "error":                 result["error"],
            "same_item_probability": 0.0,
            "verdict":               "unknown",
            "match_reasons":         [],
            "mismatch_reasons":      [],
            "confidence":            "low",
        }), 200  # 200 so frontend handles gracefully

    return jsonify(result), 200


# ─── Helper: local fallback ───────────────────────────────────────────────────
def _run_fallback_analysis(image_bytes: bytes | None) -> dict:
    """Run local ML when Gemini is unavailable."""
    result = {
        "category": "other", "confidence": 0,
        "suggested_title": "Lost/Found Item",
        "suggested_description": "Please add a description.",
        "visible_text": "", "tags": [],
    }
    if not image_bytes:
        return result
    try:
        cat = categorize_image(image_bytes)
        result["category"]   = cat.get("category", "other")
        result["confidence"] = cat.get("confidence", 0)
        result["suggested_title"] = f"Lost {cat.get('category','Item').replace('_',' ').title()}"
    except Exception as e:
        logger.warning("Fallback categorization failed: %s", e)
    try:
        ocr = extract_ocr_text(image_bytes)
        result["visible_text"] = ocr.get("raw_text", "")
        if ocr.get("extracted_fields", {}).get("name"):
            result["suggested_title"] += f" — {ocr['extracted_fields']['name']}"
    except Exception as e:
        logger.warning("Fallback OCR failed: %s", e)
    return result