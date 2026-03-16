"""
backend/extensions.py
Shared Flask extensions — imported by app.py AND routes to avoid circular imports.
"""

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_jwt_extended import JWTManager

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["200 per minute"],
)

jwt = JWTManager()
