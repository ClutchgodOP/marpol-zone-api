# app/rate_limit.py
"""
Sliding-window rate limiter using slowapi (wraps limits library).
Falls back to in-memory state if Redis is not configured —
safe for single-worker dev, use Redis in production.
"""
import os

from slowapi import Limiter
from slowapi.util import get_remote_address

REDIS_URL = os.getenv("REDIS_URL")  # e.g. redis://default:pass@host:6379/0

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=REDIS_URL or "memory://",
    default_limits=["200/hour", "30/minute"],
)
