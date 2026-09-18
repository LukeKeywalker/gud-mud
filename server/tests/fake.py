from mud_server.connections import Client


class FakeWS:
    def __init__(self):
        self.sent: list = []
        self.closed = False

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    async def send_text(self, text: str) -> None:
        raise AssertionError("no text frames in this MUD")

    async def close(self) -> None:
        self.closed = True


async def join_client(loop, name: str, start=None):
    c = Client(ws=FakeWS(), name=name)
    ent = await loop.admit(c, name)
    return c
