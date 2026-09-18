"""Generate maps/starter.txt: 5 room-columns x 4 room-rows of 8x8 rooms,
letters A..T as laid out below, 3-tile stone-arch doorways ('a'/'d'/'a')
between all attached adjacent pairs: 'd' is the only passable tile, the
'a' flanks are see-through arch stonework at the client's 1 m/tile scale."""
from pathlib import Path

LETTERS = [
    ["M", "E", "F", "N", "Q"],
    ["G", "A", "B", "H", "O"],
    ["K", "C", "D", "L", "R"],
    ["P", "I", "J", "S", "T"],
]
ROOM_W = ROOM_H = 8


def gen() -> str:
    COLS, ROWS = len(LETTERS[0]), len(LETTERS)
    W = 1 + COLS * (ROOM_W + 1)
    H = 1 + ROWS * (ROOM_H + 1)
    g = [["#"] * W for _ in range(H)]
    for j in range(ROWS):
        for i in range(COLS):
            ch = LETTERS[j][i]
            x0, y0 = 1 + i * (ROOM_W + 1), 1 + j * (ROOM_H + 1)
            for y in range(ROOM_H):
                for x in range(ROOM_W):
                    assert g[y0 + y][x0 + x] == "#"
                    g[y0 + y][x0 + x] = ch
    for j in range(ROWS):
        y = 1 + j * (ROOM_H + 1) + ROOM_H // 2
        for i in range(COLS - 1):
            x = 1 + i * (ROOM_W + 1) + ROOM_W
            for dy, ch in ((-1, "a"), (0, "d"), (1, "a")):
                assert g[y + dy][x] == "#"
                g[y + dy][x] = ch
    for i in range(COLS):
        x = 1 + i * (ROOM_W + 1) + ROOM_W // 2
        for j in range(ROWS - 1):
            y = 1 + j * (ROOM_H + 1) + ROOM_H
            for dx, ch in ((-1, "a"), (0, "d"), (1, "a")):
                assert g[y][x + dx] == "#"
                g[y][x + dx] = ch
    return "\n".join("".join(row) for row in g) + "\n"


def main() -> None:
    txt = gen()
    p = Path(__file__).resolve().parents[1] / "maps" / "starter.txt"
    p.write_text(txt)
    rows = [r for r in txt.split("\n") if r]
    assert all(len(r) == len(rows[0]) for r in rows)
    assert all(c in "#daABCDEFGHIJKLMNOPQRSTUVWXYZ" for r in rows for c in r)
    print(txt)
    print("MAP_OK", len(rows[0]), "x", len(rows))


if __name__ == "__main__":
    main()
