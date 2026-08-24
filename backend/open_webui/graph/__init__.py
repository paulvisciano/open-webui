"""Open WebUI image pipeline — ported from Knowledge Graph.

Runs entirely in-process: LightRAG is accessed via
:mod:`open_webui.services.lightrag_service` (no HTTP server), and the worker is
an asyncio task (no separate process).  Face detection is not ported.
"""

from open_webui.graph.job_manager import Job  # noqa: F401