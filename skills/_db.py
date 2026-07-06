"""Shared DB access for all feature skills.

Every feature script imports run_sql / run_sql_one from here. This module
just re-exports the direct-SQL (no-Gemini) helpers from the project's
nl_query_gemini.py, after making sure the project root is importable no
matter which folder the feature script was launched from.

    from _db import run_sql, run_sql_one

Keeping this one hop means the DB layer stays in exactly one place
(nl_query_gemini.py) and the feature scripts never duplicate connection or
read-only logic.
"""

import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from nl_query_gemini import run_sql, run_sql_one  # noqa: E402

__all__ = ["run_sql", "run_sql_one"]
