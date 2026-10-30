"""Smoke test for browser-mcp: list tools, browse, interact, screenshot.

Runs inside the browser container, which has the MCP client installed and
needs no published port:

    docker compose exec -T browser python - < pilot.py
"""

import asyncio
import base64
import sys

from mcp import Client

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8931/mcp"


def text(result) -> str:
    out = "\n".join(c.text for c in result.content if c.type == "text")
    if result.is_error:
        raise SystemExit(f"tool error: {out}")
    return out


def ref_for(snapshot: str, needle: str) -> str:
    for line in snapshot.splitlines():
        if needle in line and "[ref=" in line:
            return line.split("[ref=")[1].split("]")[0]
    raise SystemExit(f"no ref for {needle!r} in snapshot:\n{snapshot}")


async def main() -> None:
    async with Client(URL) as client:
        tools = await client.list_tools()
        print("tools:", ", ".join(t.name for t in tools.tools))

        page = text(await client.call_tool("browser_navigate", {"url": "https://example.com"}))
        print(page, "\n")
        page = text(await client.call_tool("browser_click", {"ref": ref_for(page, "link")}))
        print(page.splitlines()[0], "\n")

        shot = await client.call_tool("browser_screenshot", {})
        img = next(c for c in shot.content if c.type == "image")
        data = base64.b64decode(img.data)
        assert data.startswith((b"\x89PNG", b"\xff\xd8\xff")), "not an image"
        print(f"screenshot: {img.mime_type}, {len(data)} bytes\n")

        page = text(await client.call_tool("browser_navigate", {"url": "https://httpbin.org/forms/post"}))
        fields = [
            {"ref": ref_for(page, '"Customer name'), "value": "Ada"},
            {"ref": ref_for(page, '"Large'), "value": True},
            {"ref": ref_for(page, '"Bacon'), "value": True},
        ]
        await client.call_tool("browser_fill_form", {"fields": fields, "submit_ref": ref_for(page, '"Submit order')})
        body = text(await client.call_tool("browser_get_text", {"format": "text"}))
        assert '"custname": "Ada"' in body, body
        print("form submitted:", body[body.index("{") :][:300])


asyncio.run(main())
