"""isidore - spawn isolated Pi coding-agent tasks from a web UI or Telegram.

The package is split so the interesting parts stay testable without a web
server:

* :mod:`isidore.store`     - durable task records
* :mod:`isidore.runner`    - runs one ``pi`` subprocess per task
* :mod:`isidore.telegram`  - optional Telegram bot front-end
* :mod:`isidore.app`       - the Starlette app (REST API + minimalist UI)
"""

__version__ = "0.1.0"
