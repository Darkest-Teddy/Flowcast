"""Join saved campus routes using OSM corridors; never add straight snap edges.

Run: python3 data-pipeline/build_cross_campus_routes.py
The normalized corridor snapshot retains OSM way IDs, tags and consecutive nodes.
Only exactly matching six-decimal coordinates connect it to existing routes.
"""
import gzip
import heapq
import json
import math
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'map-client/public/data/demo-day.json'
SOURCE = ROOT / 'data-pipeline/output/campus-walk-corridors.json'
WALKABLE = set('footway path pedestrian steps living_street residential service unclassified tertiary secondary primary crossing corridor cycleway'.split())


def walkable(tags):
    foot = tags.get('foot')
    if tags.get('highway') not in WALKABLE or foot in ('no', 'private', 'use_sidepath'):
        return False
    if tags.get('access') in ('no', 'private') and foot not in ('yes', 'designated', 'permissive'):
        return False
    return tags.get('highway') != 'cycleway' or foot in ('yes', 'designated', 'permissive')


def distance(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    value = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(value))


def rebuild_source(source):
    ways = {}
    for name in ('corridor', 'bridge', 'link'):
        snapshot = ROOT / f'data-pipeline/snapshots/osm/{name}.osm.gz'
        root = ET.fromstring(gzip.decompress(snapshot.read_bytes()))
        nodes = {int(node.attrib['id']): [round(float(node.attrib['lon']), 6), round(float(node.attrib['lat']), 6)] for node in root.findall('node')}
        for way in root.findall('way'):
            tags = {tag.attrib['k']: tag.attrib['v'] for tag in way.findall('tag')}
            if not walkable(tags):
                continue
            node_ids = [int(node.attrib['ref']) for node in way.findall('nd')]
            assert all(node in nodes for node in node_ids), 'Incomplete OSM way'
            way_id = int(way.attrib['id'])
            ways[way_id] = {'id': way_id, 'tags': tags, 'path': [nodes[node] for node in node_ids]}
    source['ways'] = list(ways.values())
    SOURCE.write_text(json.dumps(source, separators=(',', ':')) + '\n')
    return source


def build(base, source):
    graph = defaultdict(dict)
    endpoints = {}
    locations = {location['id']: location for location in base['locations']}

    def add_path(path):
        for a, b in zip(path, path[1:]):
            if a != b:
                graph[a][b] = graph[b][a] = distance(a, b)

    for key, route in base['walkRoutes'].items():
        start, end = key.split('>')
        path = list(map(tuple, route['path']))
        for name, point in ((start, path[0]), (end, path[-1])):
            assert name not in endpoints or endpoints[name] == point, f'Inconsistent endpoint: {name}'
            endpoints[name] = point
        add_path(path)
    for way in source['ways']:
        if walkable(way['tags']):
            add_path(list(map(tuple, way['path'])))

    routes = {}
    campus_ids = sorted(id for id in endpoints if locations[id]['campus'] in ('fenway', 'charles-river'))
    for start in campus_ids:
        origin = endpoints[start]
        costs, previous, queue = {origin: 0}, {}, [(0, origin)]
        while queue:
            cost, node = heapq.heappop(queue)
            if cost > costs[node]:
                continue
            for neighbor, weight in graph[node].items():
                candidate = cost + weight
                if candidate < costs.get(neighbor, math.inf):
                    costs[neighbor] = candidate
                    previous[neighbor] = node
                    heapq.heappush(queue, (candidate, neighbor))
        for end in campus_ids:
            if start == end:
                continue
            cross_campus = locations[start]['campus'] != locations[end]['campus']
            if not cross_campus and 'dewolfe' not in (start, end):
                continue
            target = endpoints[end]
            assert target in costs, f'No verified corridor: {start}>{end}'
            key = f'{start}>{end}'
            old = base['walkRoutes'].get(key)
            if old and not cross_campus and costs[target] >= old['cumulative'][-1] - 1:
                continue
            path = [target]
            while path[-1] != origin:
                path.append(previous[path[-1]])
            path.reverse()
            cumulative = [0.0]
            length = 0.0
            for a, b in zip(path, path[1:]):
                assert b in graph[a]
                length += graph[a][b]
                cumulative.append(round(length, 1))
            assert path[0] == endpoints[start] and path[-1] == endpoints[end]
            routes[key] = {'path': path, 'cumulative': cumulative}
    return {'sources': source['sources'], 'retrieved': source['retrieved'], 'attribution': source['attribution'], 'walkRoutes': routes}


if __name__ == '__main__':
    base = json.loads(BASE.read_text())
    source = json.loads(SOURCE.read_text())
    if '--rebuild-source' in sys.argv:
        source = rebuild_source(source)
    result = build(base, source)
    base['walkRoutes'].update(result['walkRoutes'])
    base['walkRouteSources'] = {key: value for key, value in result.items() if key != 'walkRoutes'}
    BASE.write_text(json.dumps(base, separators=(',', ':')) + '\n')
    print(f"Merged {len(result['walkRoutes'])} routes; total {len(base['walkRoutes'])}")
