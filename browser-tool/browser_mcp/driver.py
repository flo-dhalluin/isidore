"""One long-lived Firefox session, driven through a local geckodriver.

Selenium is synchronous: every tool runs its body through `Browser.run`, which
serializes calls with a lock and executes them in a worker thread. The session
is created lazily and recreated when Firefox or geckodriver died.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import anyio
from selenium import webdriver
from selenium.common.exceptions import (
    InvalidSessionIdException,
    NoSuchWindowException,
    WebDriverException,
)
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

log = logging.getLogger(__name__)
T = TypeVar("T")

GECKODRIVER = os.environ.get("BROWSER_MCP_GECKODRIVER") or shutil.which("geckodriver") or "geckodriver"
FIREFOX = os.environ.get("BROWSER_MCP_FIREFOX") or shutil.which("firefox")
WIDTH = int(os.environ.get("BROWSER_MCP_WIDTH", "1366"))
HEIGHT = int(os.environ.get("BROWSER_MCP_HEIGHT", "900"))
PAGE_LOAD_TIMEOUT = float(os.environ.get("BROWSER_MCP_PAGE_LOAD_TIMEOUT", "30"))
HEADLESS = os.environ.get("BROWSER_MCP_HEADLESS", "1") != "0"

PREFS = {
    # Quiet, deterministic profile: no first-run pages, updates, telemetry,
    # password manager prompts, or download dialogs.
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.aboutwelcome.enabled": False,
    "app.update.auto": False,
    "app.update.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "datareporting.healthreport.uploadEnabled": False,
    "toolkit.telemetry.enabled": False,
    "signon.rememberSignons": False,
    "signon.autofillForms": False,
    "browser.download.folderList": 2,
    "browser.download.useDownloadDir": True,
    "browser.download.manager.showWhenStarting": False,
    "pdfjs.disabled": False,
    # Show JSON responses as raw text, which reads better than the viewer UI.
    "devtools.jsonview.enabled": False,
}


class Browser:
    def __init__(self) -> None:
        self._driver: webdriver.Firefox | None = None
        self._lock = anyio.Lock()
        self.download_dir = Path(tempfile.gettempdir()) / "browser-mcp-downloads"

    async def run(self, fn: Callable[[webdriver.Firefox], T]) -> T:
        """Run `fn(driver)` in a worker thread, one call at a time."""
        async with self._lock:
            return await anyio.to_thread.run_sync(self._call, fn)

    def _call(self, fn: Callable[[webdriver.Firefox], T]) -> T:
        driver = self._ensure()
        try:
            return fn(driver)
        except InvalidSessionIdException:
            # Firefox went away mid-call; the next call starts a fresh session.
            self._discard()
            raise

    def _ensure(self) -> webdriver.Firefox:
        if self._driver is not None:
            try:
                self._driver.current_window_handle
                return self._driver
            except NoSuchWindowException:
                # The current tab was closed (e.g. by the page): fall back to another.
                handles = self._driver.window_handles
                if handles:
                    self._driver.switch_to.window(handles[-1])
                    return self._driver
                log.warning("no window left, restarting Firefox")
            except WebDriverException as exc:
                log.warning("Firefox session lost (%s), restarting", exc.msg or type(exc).__name__)
            self._discard()
        self._driver = self._start()
        return self._driver

    def _start(self) -> webdriver.Firefox:
        opts = Options()
        if HEADLESS:
            opts.add_argument("-headless")
        opts.add_argument(f"--width={WIDTH}")
        opts.add_argument(f"--height={HEIGHT}")
        if FIREFOX:
            opts.binary_location = FIREFOX
        self.download_dir.mkdir(parents=True, exist_ok=True)
        for k, v in {**PREFS, "browser.download.dir": str(self.download_dir)}.items():
            opts.set_preference(k, v)
        opts.page_load_strategy = "normal"
        # geckodriver inherits this env and passes it on to Firefox.
        env = {**os.environ}
        service = Service(executable_path=GECKODRIVER, env=env, log_output=os.environ.get("BROWSER_MCP_GECKO_LOG", os.devnull))
        log.info("starting Firefox (%s, geckodriver %s)", FIREFOX or "default binary", GECKODRIVER)
        driver = webdriver.Firefox(options=opts, service=service)
        driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
        driver.set_script_timeout(30)
        return driver

    def _discard(self) -> None:
        driver, self._driver = self._driver, None
        if driver is None:
            return
        try:
            driver.quit()
        except Exception:  # noqa: BLE001 - best effort, the process may already be gone
            pass

    async def reset(self) -> None:
        async with self._lock:
            await anyio.to_thread.run_sync(self._discard)

    def close(self) -> None:
        self._discard()
