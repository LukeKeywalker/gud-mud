"""Convert selected Modular Dungeon OBJ assets to the client's JSON format.

The pack contains concave n-gons, so faces are projected to their dominant
plane and ear-clipped instead of being truncated or triangulated as a fan.
Source corner normals are retained and transformed for each asset's scale.

Usage: python3 devtools/dungeon2json.py <obj_dir_or_zip> <out_dir> [name ...]
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
from pathlib import Path
import tempfile
import zipfile


WALL_H = 3.0
WALL_DEPTH = 0.66  # Original wall proportions at a 3 m face; shared by door frames.
ARCH_SPAN = 3.0
EPS = 1e-10


def parse_mtl(text: str) -> dict[str, str]:
    mats: dict[str, str] = {}
    cur = None
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "newmtl":
            cur = fields[1]
            mats[cur] = "969696"
        elif fields[0] == "Kd" and cur:
            r, g, b = (float(x) for x in fields[1:4])

            def lin2srgb(c: float) -> float:
                return 1.055 * (c ** (1 / 2.4)) - 0.055 if c > 0.0031308 else 12.92 * c

            mats[cur] = "%02X%02X%02X" % tuple(
                int(round(min(1.0, max(0.0, lin2srgb(c))) * 255)) for c in (r, g, b)
            )
    return mats


def _obj_index(raw: str, count: int) -> int:
    """Convert an OBJ's one-based/negative index to a zero-based index."""
    value = int(raw)
    result = value - 1 if value > 0 else count + value
    if result < 0 or result >= count:
        raise ValueError(f"OBJ index {value} outside 1..{count}")
    return result


def _newell(points: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    nx = ny = nz = 0.0
    for p, q in zip(points, points[1:] + points[:1]):
        nx += (p[1] - q[1]) * (p[2] + q[2])
        ny += (p[2] - q[2]) * (p[0] + q[0])
        nz += (p[0] - q[0]) * (p[1] + q[1])
    return nx, ny, nz


def _cross2(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _signed_area(points: list[tuple[float, float]]) -> float:
    return 0.5 * sum(
        p[0] * q[1] - q[0] * p[1] for p, q in zip(points, points[1:] + points[:1])
    )


def _in_triangle(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    winding: float,
) -> bool:
    # Boundary points count as inside so an ear cannot cut through another vertex.
    return all(winding * value >= -EPS for value in (_cross2(a, b, p), _cross2(b, c, p), _cross2(c, a, p)))


def triangulate_face(
    refs: list[tuple[int, int | None]],
    verts: list[tuple[float, float, float]],
) -> list[tuple[tuple[int, int | None], tuple[int, int | None], tuple[int, int | None]]]:
    """Triangulate one simple, planar OBJ polygon while preserving its winding."""
    cleaned: list[tuple[int, int | None]] = []
    for ref in refs:
        if not cleaned or verts[ref[0]] != verts[cleaned[-1][0]]:
            cleaned.append(ref)
    if len(cleaned) > 1 and verts[cleaned[0][0]] == verts[cleaned[-1][0]]:
        cleaned.pop()
    if len(cleaned) < 3:
        return []

    points3 = [verts[ref[0]] for ref in cleaned]
    normal = _newell(points3)
    dominant = max(range(3), key=lambda axis: abs(normal[axis]))
    if abs(normal[dominant]) < EPS:
        return []
    axes = [axis for axis in range(3) if axis != dominant]
    points2 = [(point[axes[0]], point[axes[1]]) for point in points3]
    area = _signed_area(points2)
    if abs(area) < EPS:
        return []
    winding = 1.0 if area > 0 else -1.0

    remaining = list(range(len(cleaned)))
    triangles: list[tuple[tuple[int, int | None], tuple[int, int | None], tuple[int, int | None]]] = []
    while len(remaining) > 3:
        ear = None
        for slot, current in enumerate(remaining):
            before = remaining[slot - 1]
            after = remaining[(slot + 1) % len(remaining)]
            a, b, c = points2[before], points2[current], points2[after]
            if winding * _cross2(a, b, c) <= EPS:
                continue
            if any(
                _in_triangle(points2[other], a, b, c, winding)
                for other in remaining
                if other not in (before, current, after)
            ):
                continue
            ear = slot
            triangles.append((cleaned[before], cleaned[current], cleaned[after]))
            break
        if ear is None:
            raise ValueError("cannot triangulate non-simple or non-planar face")
        remaining.pop(ear)

    a, b, c = remaining
    if abs(_cross2(points2[a], points2[b], points2[c])) > EPS:
        triangles.append((cleaned[a], cleaned[b], cleaned[c]))
    return triangles


def parse_obj(path: Path):
    verts: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    parts: list[tuple[str | None, list]] = []
    cur_mat = None
    cur_faces = []
    with path.open() as source:
        for line_number, line in enumerate(source, 1):
            fields = line.split()
            if not fields:
                continue
            if fields[0] == "v":
                verts.append(tuple(float(x) for x in fields[1:4]))
            elif fields[0] == "vn":
                normals.append(tuple(float(x) for x in fields[1:4]))
            elif fields[0] == "usemtl":
                if cur_faces:
                    parts.append((cur_mat, cur_faces))
                    cur_faces = []
                cur_mat = fields[1]
            elif fields[0] == "f":
                refs = []
                for raw_ref in fields[1:]:
                    values = raw_ref.split("/")
                    vertex = _obj_index(values[0], len(verts))
                    normal = _obj_index(values[2], len(normals)) if len(values) > 2 and values[2] else None
                    refs.append((vertex, normal))
                try:
                    cur_faces.extend(triangulate_face(refs, verts))
                except ValueError as exc:
                    raise ValueError(f"{path}:{line_number}: {exc}") from exc
    if cur_faces:
        parts.append((cur_mat, cur_faces))
    return verts, normals, parts


def fit(name: str, width: float, height: float, depth: float):
    """Return X/Y/Z scaling and whether the asset uses a corner origin."""
    if name == "wall":
        # One square panel spans three tiles and reaches the ceiling. The client
        # crops short runs instead of squeezing the stones to fit them.
        # Preserve the source's approximate depth ratio independently of collision.
        return WALL_H / width, WALL_H / height, WALL_DEPTH / depth, False
    if name == "floor":
        return 1.0 / width, 0.125 / height, 1.0 / depth, False
    if name == "arch":
        return ARCH_SPAN / width, WALL_H / height, WALL_DEPTH / depth, False
    return 0.5, 0.5, 0.5, name == "cobweb"


def _geometric_normal(points):
    a, b, c = points
    u = tuple(b[i] - a[i] for i in range(3))
    v = tuple(c[i] - a[i] for i in range(3))
    normal = (
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    )
    length = math.sqrt(sum(value * value for value in normal))
    return tuple(value / length for value in normal) if length > EPS else None


def _transform_normal(normal, scale):
    transformed = tuple(normal[i] / scale[i] for i in range(3))
    length = math.sqrt(sum(value * value for value in transformed))
    return tuple(value / length for value in transformed) if length > EPS else None


def build(name: str, src: str, obj_dir: Path, out_dir: Path) -> dict:
    obj = obj_dir / f"{src}.obj"
    mats = parse_mtl((obj_dir / f"{src}.mtl").read_text())
    verts, normals, part_groups = parse_obj(obj)
    minimum = [min(v[axis] for v in verts) for axis in range(3)]
    maximum = [max(v[axis] for v in verts) for axis in range(3)]
    width, height, depth = (maximum[i] - minimum[i] for i in range(3))
    sx, sy, sz, corner = fit(name, width, height, depth)
    center_x = minimum[0] if corner else (minimum[0] + maximum[0]) / 2
    center_z = minimum[2] if corner else (minimum[2] + maximum[2]) / 2
    # Floor slabs sit below ground; actors, walls and props stand at y=0.
    ground_y = maximum[1] if name == "floor" else minimum[1]
    scale = sx, sy, sz
    transformed = [
        ((x - center_x) * sx, (y - ground_y) * sy, (z - center_z) * sz)
        for x, y, z in verts
    ]

    out = {"parts": []}
    skipped = 0
    for material, triangles in part_groups:
        if material not in mats:
            raise ValueError(f"{obj}: unknown material {material!r}")
        positions: list[float] = []
        output_normals: list[float] = []
        indices: list[int] = []
        for triangle in triangles:
            points = [transformed[ref[0]] for ref in triangle]
            face_normal = _geometric_normal(points)
            if face_normal is None:
                skipped += 1
                continue
            base = len(positions) // 3
            for ref, point in zip(triangle, points):
                normal = _transform_normal(normals[ref[1]], scale) if ref[1] is not None else face_normal
                if normal is None:
                    normal = face_normal
                positions.extend(round(value, 5) for value in point)
                output_normals.extend(round(value, 5) for value in normal)
            indices.extend((base, base + 1, base + 2))
        out["parts"].append(
            {
                "material": material,
                "color": f"#{mats[material]}",
                "pos": positions,
                "nrm": output_normals,
                "idx": indices,
            }
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    output = out_dir / f"{name}.json"
    output.write_text(json.dumps(out, separators=(",", ":")))
    triangles = sum(len(part["idx"]) // 3 for part in out["parts"])
    bounds = [
        [round(min(point[axis] for point in transformed), 5), round(max(point[axis] for point in transformed), 5)]
        for axis in range(3)
    ]
    report = {
        "asset": name,
        "source": src,
        "triangles": triangles,
        "skipped_degenerate_triangles": skipped,
        "bounds": bounds,
        "bytes": output.stat().st_size,
    }
    print(json.dumps(report, separators=(",", ":")))
    return report


SOURCES = {
    "wall": "Wall_Modular",
    "floor": "Floor_Modular",
    "arch": "Arch",
    "cobweb": "Cobweb",
    "crate": "Crate",
    "barrel": "Barrel",
}


@contextmanager
def source_directory(source: Path):
    """Yield an OBJ directory from either an extracted directory or the pack ZIP."""
    source = source.resolve()
    if source.is_dir():
        yield source
        return
    if not source.is_file() or source.suffix.lower() != ".zip":
        raise ValueError(f"source must be an OBJ directory or ZIP archive: {source}")
    needed = {f"{asset}.{suffix}" for asset in SOURCES.values() for suffix in ("obj", "mtl")}
    with tempfile.TemporaryDirectory(prefix="mud-dungeon-assets-") as temp_name, zipfile.ZipFile(source) as archive:
        temp_dir = Path(temp_name)
        by_name = {}
        for member in archive.namelist():
            filename = Path(member).name
            if filename in needed:
                if filename in by_name:
                    raise ValueError(f"archive contains duplicate {filename}")
                by_name[filename] = member
        missing = sorted(needed - set(by_name))
        if missing:
            raise ValueError(f"archive is missing: {', '.join(missing)}")
        for filename, member in by_name.items():
            (temp_dir / filename).write_bytes(archive.read(member))
        yield temp_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="extracted OBJ directory or modular-dungeon ZIP")
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("names", nargs="*", metavar="asset")
    args = parser.parse_args(argv)
    unknown = sorted(set(args.names) - set(SOURCES))
    if unknown:
        parser.error(f"unknown asset(s): {', '.join(unknown)}")
    try:
        with source_directory(args.source) as obj_dir:
            for name in args.names or list(SOURCES):
                build(name, SOURCES[name], obj_dir, args.out_dir.resolve())
    except ValueError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
