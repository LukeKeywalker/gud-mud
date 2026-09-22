import math

from devtools import dungeon2json as converter


def polygon_area(points):
    return abs(
        sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
    ) / 2


def triangle_area(triangle, vertices):
    points = [vertices[ref[0]][:2] for ref in triangle]
    return abs(converter._cross2(*points)) / 2


def test_concave_polygon_is_fully_triangulated_in_both_windings():
    vertices = [
        (0.0, 0.0, 0.0),
        (3.0, 0.0, 0.0),
        (3.0, 1.0, 0.0),
        (1.0, 1.0, 0.0),
        (1.0, 3.0, 0.0),
        (0.0, 3.0, 0.0),
    ]
    expected_area = polygon_area([point[:2] for point in vertices])
    for order in (range(len(vertices)), reversed(range(len(vertices)))):
        triangles = converter.triangulate_face([(i, None) for i in order], vertices)
        assert len(triangles) == len(vertices) - 2
        assert math.isclose(sum(triangle_area(t, vertices) for t in triangles), expected_area)


def test_obj_indices_support_positive_and_relative_forms():
    assert converter._obj_index("1", 4) == 0
    assert converter._obj_index("4", 4) == 3
    assert converter._obj_index("-1", 4) == 3
    assert converter._obj_index("-4", 4) == 0


def test_arch_fit_matches_three_tile_doorway():
    sx, sy, sz, corner = converter.fit("arch", 4.0, 4.0, 1.0)
    assert (4.0 * sx, 4.0 * sy, 1.0 * sz) == (3.0, 3.0, 0.66)
    assert corner is False


def test_wall_depth_preserves_source_proportions_instead_of_filling_collision_cell():
    sx, sy, sz, corner = converter.fit("wall", 2.0, 2.0, 0.44)
    assert sx == sy == sz == 1.5
    assert math.isclose(0.44 * sz, 0.66)
    assert corner is False


def test_nonuniform_scale_uses_inverse_transpose_for_normals():
    normal = converter._transform_normal((1.0, 1.0, 0.0), (0.5, 2.0, 1.0))
    expected_length = math.sqrt(2.0**2 + 0.5**2)
    assert normal == (2.0 / expected_length, 0.5 / expected_length, 0.0)
