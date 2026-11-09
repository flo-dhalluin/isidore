"""scheduler - one-shot and recurring tasks for isidore.

The core (:mod:`scheduler.core`) is pure Python and has no web or MCP
dependencies, so schedule arithmetic and persistence can be tested in
isolation. :mod:`scheduler.server` exposes it as an MCP tool server and a
small REST API.
"""

__version__ = "0.1.0"
