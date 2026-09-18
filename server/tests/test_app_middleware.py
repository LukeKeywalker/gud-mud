import asyncio

import httpx
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from mud_server.app import NoCacheMidd


def test_nocache_headers_and_wiring():
    async def ok(request):
        return PlainTextResponse("ok")

    app = Starlette(
        middleware=[Middleware(NoCacheMidd)],
        routes=[
            Route("/app.js", ok),
            Route("/index.html", ok),
            Route("/three.module.js", ok),
            Route("/other.txt", ok),
        ],
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as client:
            return await client.get("/app.js"), await client.get("/index.html"), \
                await client.get("/three.module.js"), await client.get("/other.txt")

    r_app, r_home, r_three, r_other = asyncio.run(run())
    assert r_app.headers["cache-control"] == "no-cache"
    assert r_home.headers["cache-control"] == "no-cache"
    assert "cache-control" not in r_three.headers
    assert "cache-control" not in r_other.headers
