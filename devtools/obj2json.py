import json, sys
from pathlib import Path

OBJ_DIR = Path(sys.argv[1])
OUT_DIR = Path(sys.argv[2])
FIT = 0.8

def parse_mtl(text):
    mats, cur = {}, None
    for line in text.splitlines():
        if line.startswith("newmtl"):
            cur = line.split()[1]
            mats[cur] = "969696"
        elif line.startswith("Kd") and cur:
            r, g, b = (float(x) for x in line.split()[1:4])
            def lin2srgb(c):
                return 1.055 * (c ** (1 / 2.4)) - 0.055 if c > 0.0031308 else 12.92 * c
            mats[cur] = "%02X%02X%02X" % tuple(
                int(round(min(1.0, lin2srgb(c)) * 255)) for c in (r, g, b)
            )
    return mats

def parse_obj(path, default_mat):
    verts, vn = [], []
    parts = []
    cur_mat, cur_faces = None, []
    with open(path) as f:
        for line in f:
            t = line.split()
            if not t:
                continue
            if t[0] == "v":
                verts.append([float(t[1]), float(t[2]), float(t[3])])
            elif t[0] == "vn":
                vn.append([float(t[1]), float(t[2]), float(t[3])])
            elif t[0] == "usemtl":
                if cur_faces:
                    parts.append((cur_mat or default_mat, cur_faces))
                    cur_faces = []
                cur_mat = t[1]
            elif t[0] == "f":
                idx = []
                for ref in t[1:]:
                    p = ref.split("/")
                    idx.append((int(p[0]), int(p[2]) if len(p) > 2 and p[2] else 1))
                quads = ((0, 1, 2), (0, 2, 3)) if len(idx) == 4 else ((0, 1, 2),)
                for a, b, c in quads:
                    cur_faces.append([idx[a], idx[b], idx[c]])
    if cur_faces:
        parts.append((cur_mat or default_mat, cur_faces))
    return verts, vn, parts

def build(name):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    obj = OBJ_DIR / (name + ".obj")
    mats = parse_mtl((OBJ_DIR / (name + ".mtl")).read_text())
    verts, vn, part_groups = parse_obj(obj, next(iter(mats)))

    minx = miny = minz = float("inf")
    maxx = maxy = maxz = float("-inf")
    for (x, y, z) in verts:
        minx, miny, minz = min(minx, x), min(miny, y), min(minz, z)
        maxx, maxy, maxz = max(maxx, x), max(maxy, y), max(maxz, z)
    s = FIT / max(maxx - minx, maxy - miny, maxz - minz)
    cx, cz = (minx + maxx) / 2, (minz + maxz) / 2

    def smoothnormal(a, b, c):
        (ax, ay, az), (bx, by, bz), (cx2, cy2, cz2) = a, b, c
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx2 - ax, cy2 - ay, cz2 - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        l = (nx * nx + ny * ny + nz * nz) ** 0.5
        return (nx / l, ny / l, nz / l) if l > 1e-12 else None

    out = {"parts": []}
    for mat, tris in part_groups:
        seen = {}
        pos, nrm, idx = [], [], []
        for tri in tris:
            tripts = []
            local = []
            for (vi, ni) in tri:
                x, y, z = verts[vi - 1]
                key = (round((x - cx) * s, 4), round((y - miny) * s, 4), round((z - cz) * s, 4))
                if key not in seen:
                    seen[key] = len(pos) // 3
                    pos += [key[0], key[1], key[2]]
                    nrm += [0.0, 0.0, 0.0]
                local.append(seen[key])
                tripts.append((pos[3 * local[-1]], pos[3 * local[-1] + 1], pos[3 * local[-1] + 2]))
            n = smoothnormal(tripts[0], tripts[1], tripts[2])
            if n is not None:
                for i in local:
                    nrm[3 * i] += n[0]
                    nrm[3 * i + 1] += n[1]
                    nrm[3 * i + 2] += n[2]
            idx += [local[0], local[1], local[2]]
        for i in range(len(pos) // 3):
            l = (nrm[3 * i] ** 2 + nrm[3 * i + 1] ** 2 + nrm[3 * i + 2] ** 2) ** 0.5
            if l < 1e-12:
                nrm[3 * i:3 * i + 3] = [0.0, 1.0, 0.0]
            else:
                nrm[3 * i:3 * i + 3] = [nrm[3 * i] / l, nrm[3 * i + 1] / l, nrm[3 * i + 2] / l]
        nrm = [round(v, 5) for v in nrm]
        out["parts"].append({"material": mat, "color": "#" + mats[mat], "pos": pos, "nrm": nrm, "idx": idx})
    outname = name.lower() + ".json"
    (OUT_DIR / outname).write_text(json.dumps(out, separators=(",", ":")))
    total = sum(len(p["idx"]) // 3 for p in out["parts"])
    detail = ", ".join("{}: {} tris".format(p["material"], len(p["idx"]) // 3) for p in out["parts"])
    print(f"{name}: {total} tris ({detail}), {(OUT_DIR / outname).stat().st_size} bytes")

for n in (sys.argv[3:] or ["Rat", "Spider"]):
    build(n)
