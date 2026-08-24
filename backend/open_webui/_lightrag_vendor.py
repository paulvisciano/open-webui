"""Register the vendored LightRAG package as a top-level importable name.

The LightRAG package is vendored under ``open_webui.lightrag`` but its ~95
internal modules use absolute imports of the form ``from lightrag.xxx import``
and ``import lightrag.xxx``.  Rewriting every one of those would be fragile
and would make future upstream merges painful.

Instead, we alias the top-level ``lightrag`` name to the vendored
``open_webui.lightrag`` subpackage once, at import time.  After this shim
runs, both of the following work everywhere in the process:

    from open_webui.lightrag import LightRAG
    from lightrag import LightRAG
    from lightrag.lightrag import LightRAG

This module is imported eagerly from ``open_webui/__init__.py`` so the alias
is established before any LightRAG code is imported, directly or transitively.

The aliasing is idempotent — running it twice is a no-op.
"""

from __future__ import annotations

import sys

_VENDORED_PATH = "open_webui.lightrag"


def _register_lightrag_alias() -> None:
    existing = sys.modules.get("lightrag")
    if existing is not None and getattr(existing, "__owui_vendored__", False):
        return

    vendored = __import__(_VENDORED_PATH, fromlist=["__name__"])
    vendored.__owui_vendored__ = True  # type: ignore[attr-defined]
    sys.modules["lightrag"] = vendored


_register_lightrag_alias()