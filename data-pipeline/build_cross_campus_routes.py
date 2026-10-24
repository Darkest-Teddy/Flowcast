"""Join saved campus routes using OSM corridors; never add straight snap edges.

Run: python3 data-pipeline/build_cross_campus_routes.py (after make_demo_routes.py)
The normalized corridor snapshot retains OSM way IDs, tags and consecutive nodes.
It is routed together with the Fenway and Charles River walk networks make_demo_routes.py uses
(read from its Overpass cache) on the same sidewalk-first graph (pedestrian_network.py), so
cross-campus walkers keep to sidewalks and crosswalks too. Ways connect only at exactly matching
six-decimal vertices, and every route starts and ends at its location's saved route endpoint.
"""
import gzip
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pedestrian_network
from pedestrian_network import walkable  # noqa: F401  (re-exported for tests and callers)

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'map-client/public/data/demo-day.json'
SOURCE = ROOT / 'data-pipeline/output/campus-walk-corridors.json'
CAMPUSES = ('fenway', 'charles-river')


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


def campus_ways():
    """The tagged OSM ways of the Fenway and Charles River walk networks (make_demo_routes.py)."""
    import make_demo_routes
    ways = []
    for campus in make_demo_routes.load_campuses():
        if campus['id'] in CAMPUSES:
            ways += make_demo_routes.fetch_walk_ways(make_demo_routes.network_bbox(campus))
    return ways


def build(base, source, ways):
    network = pedestrian_network.Network()
    for way in [*ways, *source['ways']]:
        network.add_way(way['tags'], way['path'])
    locations = {location['id']: location for location in base['locations']}

    endpoints = {}
    for key, route in base['walkRoutes'].items():
        start, end = key.split('>')
        path = route['path']
        for name, point in ((start, path[0]), (end, path[-1])):
            point = pedestrian_network.key(*point)
            assert name not in endpoints or endpoints[name] == point, f'Inconsistent endpoint: {name}'
            endpoints[name] = point

    routes = {}
    campus_ids = sorted(id for id in endpoints if locations[id]['campus'] in CAMPUSES)
    for name in campus_ids:  # a saved endpoint part-way along a way becomes a vertex of it
        assert network.attach(endpoints[name], max_metres=0.5, exact=True), f'Endpoint off the walk network: {name}'
    for start in campus_ids:
        origin = endpoints[start]
        costs, previous = network.shortest(origin)
        for end in campus_ids:
            if start == end:
                continue
            cross_campus = locations[start]['campus'] != locations[end]['campus']
            if not cross_campus and 'dewolfe' not in (start, end):
                continue
            target = endpoints[end]
            assert target in costs, f'No verified corridor: {start}>{end}'
            nodes = [target]
            while nodes[-1] != origin:
                nodes.append(previous[nodes[-1]])
            nodes.reverse()
            path = network.route_geometry(nodes)
            assert tuple(path[0]) == origin and tuple(path[-1]) == target
            routes[f'{start}>{end}'] = {'path': path, 'cumulative': pedestrian_network.cumulative(path)}
    return {'sources': source['sources'], 'retrieved': source['retrieved'], 'attribution': source['attribution'], 'walkRoutes': routes}


if __name__ == '__main__':
    base = json.loads(BASE.read_text())
    source = json.loads(SOURCE.read_text())
    if '--rebuild-source' in sys.argv:
        source = rebuild_source(source)
    result = build(base, source, campus_ways())
    base['walkRoutes'].update(result['walkRoutes'])
    base['walkRouteSources'] = {key: value for key, value in result.items() if key != 'walkRoutes'}
    BASE.write_text(json.dumps(base, separators=(',', ':')) + '\n')
    print(f"Merged {len(result['walkRoutes'])} routes; total {len(base['walkRoutes'])}")
