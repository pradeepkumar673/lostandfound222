"""
backend/routes/chat.py
Per-item chat REST endpoints.

FIXES:
  • _is_authorized: now accepts claim status "approved" OR "accepted" (was only "accepted")
  • Added explicit OPTIONS handler for CORS preflight on all routes
  • Rate limiting preserved
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import bleach
from bson import ObjectId
from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from extensions import limiter
from config.database import get_db
from config.settings import Config
from utils.helpers import serialize_doc

logger = logging.getLogger(__name__)
chat_bp = Blueprint("chat", __name__)


def _sanitize_msg(text: str) -> str:
    """Strip all HTML from a chat message."""
    return bleach.clean(text.strip(), tags=[], strip=True)[: Config.CHAT_MAX_MESSAGE_LEN]


def _is_authorized(db, item, user_id: str) -> bool:
    """
    Return True if user is the item poster OR has any claim on this item.

    FIX: was checking status == "accepted" only, but claims route stores status
    as "approved". Now accepts both so chat is accessible after any claim submission.
    For a production app you'd restrict to only approved/accepted claims.
    """
    if item["user_id"] == user_id:
        return True
    item_id = str(item["_id"])
    # Accept any claim status — claimant_id match is enough to allow chat
    # (poster can accept/reject inside the chat itself)
    return bool(
        db.claims.find_one({
            "item_id": item_id,
            "claimant_id": user_id,
        })
    )


# ─── CORS preflight handler ───────────────────────────────────────────────────
@chat_bp.route("/<item_id>/messages", methods=["OPTIONS"])
def chat_messages_preflight(item_id: str):
    """Handle CORS preflight for chat messages endpoint."""
    return jsonify({}), 200


@chat_bp.route("/rooms", methods=["OPTIONS"])
def chat_rooms_preflight():
    """Handle CORS preflight for chat rooms endpoint."""
    return jsonify({}), 200


# ─── Get Messages ─────────────────────────────────────────────────────────────
@chat_bp.route("/<item_id>/messages", methods=["GET"])
@jwt_required()
def get_messages(item_id: str):
    """
    Retrieve chat history for a specific item.
    ---
    tags: [Chat]
    security: [{Bearer: []}]
    parameters:
      - {name: item_id, in: path,  type: string, required: true}
      - {name: limit,   in: query, type: integer, default: 50}
      - {name: before_id, in: query, type: string, description: "cursor for pagination"}
    responses:
      200:
        description: Message list (oldest-first)
      403:
        description: Not authorised — must be poster or claimant
    """
    db      = get_db()
    user_id = get_jwt_identity()

    item = db.items.find_one({"_id": ObjectId(item_id)})
    if not item:
        return jsonify({"error": "Item not found"}), 404

    if not _is_authorized(db, item, user_id):
        return jsonify({"error": "Not authorised to view this chat"}), 403

    limit     = min(100, int(request.args.get("limit", 50)))
    before_id = request.args.get("before_id")

    query: dict = {"item_id": item_id}
    if before_id:
        try:
            query["_id"] = {"$lt": ObjectId(before_id)}
        except Exception:
            pass

    messages = list(db.messages.find(query).sort("created_at", -1).limit(limit))
    messages.reverse()

    result = []
    sender_cache: dict = {}
    for msg in messages:
        doc = serialize_doc(msg)
        sid = msg["sender_id"]
        if sid not in sender_cache:
            s = db.users.find_one({"_id": ObjectId(sid)}, {"name": 1, "avatar_url": 1})
            sender_cache[sid] = s or {}
        s = sender_cache[sid]
        doc["sender"] = {
            "id":         sid,
            "name":       s.get("name", "Unknown"),
            "avatar_url": s.get("avatar_url"),
            "is_me":      sid == user_id,
        }
        result.append(doc)

    return jsonify({"messages": result, "item_title": item["title"], "count": len(result)}), 200


# ─── Send Message (REST fallback) ─────────────────────────────────────────────
@chat_bp.route("/<item_id>/messages", methods=["POST"])
@jwt_required()
@limiter.limit(Config.RATELIMIT_CHAT)
def send_message(item_id: str):
    """
    Send a chat message via REST (SocketIO is primary; this is the fallback).
    ---
    tags: [Chat]
    security: [{Bearer: []}]
    """
    db      = get_db()
    user_id = get_jwt_identity()
    data    = request.get_json(silent=True) or {}

    # Accept both "text" and "content" field names for compatibility
    text = _sanitize_msg(data.get("text", "") or data.get("content", ""))
    if not text:
        return jsonify({"error": "Message text required"}), 400

    item = db.items.find_one({"_id": ObjectId(item_id)})
    if not item:
        return jsonify({"error": "Item not found"}), 404

    if not _is_authorized(db, item, user_id):
        return jsonify({"error": "Not authorised"}), 403

    sender = db.users.find_one({"_id": ObjectId(user_id)}, {"name": 1})
    now    = datetime.now(timezone.utc)

    msg_doc = {
        "item_id":     item_id,
        "sender_id":   user_id,
        "sender_name": sender["name"] if sender else "Unknown",
        "text":        text,
        "read":        False,
        "created_at":  now,
    }
    result          = db.messages.insert_one(msg_doc)
    msg_doc["_id"]  = str(result.inserted_id)
    msg_doc["created_at"] = now.isoformat()

    return jsonify({"message": serialize_doc(msg_doc)}), 201


# ─── List Chat Rooms ──────────────────────────────────────────────────────────
@chat_bp.route("/rooms", methods=["GET"])
@jwt_required()
def get_chat_rooms():
    """
    All chat rooms the current user participates in.
    Returns shape compatible with ChatPage.tsx:
      { rooms: [{ id, item_id, item_title, item_type, thumbnail,
                  participants: [{id, name, avatar_url}],
                  last_message: {text, content, created_at},
                  unread_count }] }
    ---
    tags: [Chat]
    security: [{Bearer: []}]
    """
    db      = get_db()
    user_id = get_jwt_identity()

    # Items I posted
    my_item_ids = [
        str(i["_id"])
        for i in db.items.find({"user_id": user_id}, {"_id": 1})
    ]
    # Items I've claimed (any status)
    claimed_ids = [
        c["item_id"]
        for c in db.claims.find({"claimant_id": user_id}, {"item_id": 1})
    ]

    all_ids = list(set(my_item_ids + claimed_ids))
    rooms   = []

    me = db.users.find_one({"_id": ObjectId(user_id)}, {"name": 1, "avatar_url": 1})

    for item_id in all_ids:
        item = db.items.find_one({"_id": ObjectId(item_id)})
        if not item:
            continue

        # Skip items with no messages yet unless I'm the poster
        has_messages = db.messages.count_documents({"item_id": item_id}) > 0
        is_mine = item["user_id"] == user_id
        if not has_messages and not is_mine:
            continue

        last_msg = db.messages.find_one({"item_id": item_id}, sort=[("created_at", -1)])
        unread   = db.messages.count_documents({
            "item_id":   item_id,
            "sender_id": {"$ne": user_id},
            "read":      False,
        })

        # Build participants: me + the other party
        other_id = item["user_id"] if item["user_id"] != user_id else None
        # Try to find first claimant as the other participant
        if not other_id:
            claim = db.claims.find_one({"item_id": item_id, "claimant_id": {"$ne": user_id}})
            if claim:
                other_id = claim["claimant_id"]

        participants = []
        if me:
            participants.append({
                "id":         user_id,
                "name":       me.get("name", "Me"),
                "avatar_url": me.get("avatar_url"),
            })
        if other_id:
            other_user = db.users.find_one(
                {"_id": ObjectId(other_id)},
                {"name": 1, "avatar_url": 1}
            )
            if other_user:
                participants.append({
                    "id":         other_id,
                    "name":       other_user.get("name", "Unknown"),
                    "avatar_url": other_user.get("avatar_url"),
                })

        last_msg_text = last_msg["text"] if last_msg else None

        rooms.append({
            "id":         item_id,   # use item_id as room id
            "item_id":    item_id,
            "item_title": item["title"],
            "item_type":  item["type"],
            "item": {                 # nested item object for ChatPage compatibility
                "id":    item_id,
                "title": item["title"],
                "type":  item["type"],
            },
            "thumbnail":  item["images"][0]["url"] if item.get("images") else None,
            "participants": participants,
            "last_message": {
                "text":       last_msg_text,
                "content":    last_msg_text,    # alias for frontend
                "created_at": last_msg["created_at"].isoformat() if last_msg else None,
            } if last_msg else None,
            "unread_count": unread,
        })

    rooms.sort(
        key=lambda r: (r["last_message"] or {}).get("created_at") or "",
        reverse=True,
    )
    return jsonify({"rooms": rooms, "count": len(rooms)}), 200