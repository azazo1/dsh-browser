#!/usr/bin/env python3
"""从 SVG 源稿生成扩展图标, 只使用 Python 标准库.

Chrome 的扩展图标使用 PNG. 源稿保留为 SVG, 四种 PNG 共用同一套几何与颜色.
支持源稿使用的圆角矩形, 圆和带圆角描边的多边形; 不支持的 SVG 内容会报错.

用法:
    python3 scripts/make-icons.py
    python3 scripts/make-icons.py --out assets/extension/assets/icons
"""

from __future__ import annotations

import argparse
import logging
import math
import struct
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
SOURCE = Path(__file__).resolve().parent.parent / 'extension/assets/icons/icon.svg'
LOGGER = logging.getLogger('dsh-browser.icons')


def rgb(value: str) -> tuple[int, int, int]:
    """读取源稿中的六位十六进制颜色."""
    if len(value) != 7 or not value.startswith('#'):
        raise ValueError(f'不支持的颜色: {value}')
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def rounded_rect_coverage(x: float, y: float, x0: float, y0: float, x1: float, y1: float, radius: float) -> bool:
    """判断点是否落在圆角矩形内."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + radius), x1 - radius)
    cy = min(max(y, y0 + radius), y1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def polygon_coverage(x: float, y: float, points: list[tuple[float, float]]) -> bool:
    """用射线法判断点是否在多边形内."""
    inside = False
    for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def segment_distance(x: float, y: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    """计算到线段的距离, 描边端点自然形成圆角."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    t = 0.0 if length_squared == 0 else min(1.0, max(0.0, ((x - ax) * dx + (y - ay) * dy) / length_squared))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def read_shapes(source: Path) -> list[dict]:
    """解析源稿, 严格限制支持的图元以避免静默生成错误图标."""
    root = ET.parse(source).getroot()
    if root.get('viewBox') != '0 0 128 128':
        raise ValueError('源稿必须使用 0 0 128 128 的 viewBox')
    shapes = []
    allowed = {
        'rect': {'x', 'y', 'width', 'height', 'rx', 'fill'},
        'circle': {'cx', 'cy', 'r', 'fill'},
        'polygon': {'points', 'fill', 'stroke', 'stroke-width', 'stroke-linejoin'},
    }
    for element in root:
        kind = element.tag.rsplit('}', 1)[-1]
        if kind in ('title', 'desc'):
            continue
        if kind not in allowed or set(element.attrib) - allowed[kind]:
            raise ValueError(f'源稿包含不支持的 SVG 图元或属性: {kind}')
        shape = {'kind': kind, 'fill': rgb(element.attrib['fill'])}
        if kind == 'polygon':
            shape['points'] = [tuple(map(float, pair.split(','))) for pair in element.attrib['points'].split()]
            if len(shape['points']) < 3 or any(len(point) != 2 for point in shape['points']):
                raise ValueError('多边形至少需要三个二维顶点')
            shape['stroke'] = rgb(element.attrib['stroke'])
            shape['stroke_width'] = float(element.attrib['stroke-width'])
            if element.get('stroke-linejoin') != 'round':
                raise ValueError('多边形描边必须使用 round 连接')
            half = shape['stroke_width'] / 2
            xs, ys = zip(*shape['points'])
            shape['bounds'] = (min(xs) - half, min(ys) - half, max(xs) + half, max(ys) + half)
        else:
            for name in allowed[kind] - {'fill'}:
                shape[name] = float(element.get(name, '0'))
        shapes.append(shape)
    return shapes


def color_at(x: float, y: float, shapes: list[dict]) -> tuple[int, int, int, int]:
    """按 SVG 绘制顺序采样颜色."""
    color = (0, 0, 0, 0)
    for shape in shapes:
        kind = shape['kind']
        hit = False
        if kind == 'rect':
            hit = rounded_rect_coverage(x, y, shape['x'], shape['y'], shape['x'] + shape['width'], shape['y'] + shape['height'], shape['rx'])
        elif kind == 'circle':
            hit = (x - shape['cx']) ** 2 + (y - shape['cy']) ** 2 <= shape['r'] ** 2
        elif kind == 'polygon':
            points = shape['points']
            # 指针占据画布的局部区域, 先排除无关像素以节省采样时间.
            half = shape['stroke_width'] / 2
            x0, y0, x1, y1 = shape['bounds']
            if x0 <= x <= x1 and y0 <= y <= y1:
                hit = polygon_coverage(x, y, points)
                edge = min(segment_distance(x, y, a, b) for a, b in zip(points, points[1:] + points[:1]))
                if edge <= half:
                    color = (*shape['stroke'], 255)
                    continue
        if hit:
            color = (*shape['fill'], 255)
    return color


def draw(size: int, shapes: list[dict]) -> list[list[tuple[int, int, int, int]]]:
    """超采样后按 alpha 加权降采样, 保持透明边缘平滑."""
    scale = SUPERSAMPLE
    unit = 128 / (size * scale)
    out = []
    for oy in range(size):
        row = []
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(scale):
                for sx in range(scale):
                    pr, pg, pb, pa = color_at((ox * scale + sx + 0.5) * unit, (oy * scale + sy + 0.5) * unit, shapes)
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((round(r / a), round(g / a), round(b / a), round(a / (scale * scale))))
        out.append(row)
    return out


def write_png(path: Path, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    """把 RGBA 矩阵写成 8 位 PNG."""
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for pixel in row:
            raw += bytes(pixel)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    parser = argparse.ArgumentParser(description='从 SVG 源稿生成 dsh-browser 扩展图标')
    parser.add_argument('--out', type=Path, default=SOURCE.parent, help='输出目录')
    args = parser.parse_args()
    shapes = read_shapes(SOURCE)
    args.out.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        target = args.out / f'icon-{size}.png'
        write_png(target, draw(size, shapes))
        LOGGER.info('已生成 %s (%s 字节)', target, target.stat().st_size)
    svg_target = args.out / SOURCE.name
    if svg_target.resolve() != SOURCE.resolve():
        svg_target.write_bytes(SOURCE.read_bytes())
        LOGGER.info('已保留 SVG 源稿: %s', svg_target)


if __name__ == '__main__':
    main()
