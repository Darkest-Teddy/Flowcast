"""
Pulls real BU campus geometry from OpenStreetMap: building footprints
(with heights where tagged) and the pedestrian walkway network.

Output goes to data-pipeline/output/ as GeoJSON, which map-client reads
directly as a Mapbox GL JS vector source (Section 6.1/6.5 of the plan).

This does NOT touch maps.bu.edu or any Concept3D asset — OpenStreetMap
is a separate, free, open-data source with no licensing restriction on
how we use or redistribute it (ODbL: attribution required, which the
map-client's footer/about panel should include).
"""

import json
import sys
from pathlib import Path

import osmnx as ox

# "Boston University" alone can resolve to an ambiguous or incomplete OSM
# boundary relation. Use a named place query first; if it fails or returns
# something clearly too small/large, fall back to a manual bounding box
# around the Charles River Campus (see Section 6.5's fallback instruction).
PLACE_QUERY = "Boston University, Boston, MA, USA"

# Fallback bounding box around BU's Charles River Campus, used only if the
# place query above doesn't resolve to a sensible boundary. Covers roughly
# Comm Ave from Kenmore Sq to the BU Bridge, river to south, Babcock St to
# north -- wide enough to include dorms, dining halls, CAS, GSU, Mugar.
FALLBACK_BBOX = {
    "north": 42.3545,
    "south": 42.3480,
    "east": -71.0950,
    "west": -71.1150,
}

OUTPUT_DIR = Path(__file__).parent / "output"


def extract_buildings():
    """Returns a GeoDataFrame of tagged building footprints."""
    try:
        gdf = ox.features_from_place(PLACE_QUERY, tags={"building": True})
        if gdf.empty or len(gdf) < 10:
            raise ValueError(f"Place query returned only {len(gdf)} buildings -- too few, falling back to bbox")
        print(f"[buildings] resolved '{PLACE_QUERY}' -> {len(gdf)} building features")
        return gdf
    except Exception as e:
        print(f"[buildings] place query failed or insufficient ({e}); using fallback bbox")
        bbox = (FALLBACK_BBOX["north"], FALLBACK_BBOX["south"], FALLBACK_BBOX["east"], FALLBACK_BBOX["west"])
        gdf = ox.features_from_bbox(bbox=bbox, tags={"building": True})
        print(f"[buildings] fallback bbox -> {len(gdf)} building features")
        return gdf


def extract_walkways():
    """Returns a networkx graph of the pedestrian path network."""
    try:
        graph = ox.graph_from_place(PLACE_QUERY, network_type="walk")
        if graph.number_of_nodes() < 20:
            raise ValueError(f"Place query returned only {graph.number_of_nodes()} nodes -- too few, falling back to bbox")
        print(f"[walkways] resolved '{PLACE_QUERY}' -> {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")
        return graph
    except Exception as e:
        print(f"[walkways] place query failed or insufficient ({e}); using fallback bbox")
        bbox = (FALLBACK_BBOX["north"], FALLBACK_BBOX["south"], FALLBACK_BBOX["east"], FALLBACK_BBOX["west"])
        graph = ox.graph_from_bbox(bbox=bbox, network_type="walk")
        print(f"[walkways] fallback bbox -> {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")
        return graph


def buildings_to_geojson(gdf, out_path):
    # Keep only the columns the map-client actually needs -- raw OSM tag
    # tables carry dozens of sparse columns that bloat the file for no
    # reason. name/building/height/addr:housenumber are what Section 6.5
    # and the building-name lookup (Section 6.6) rely on.
    keep_cols = [c for c in ["name", "building", "height", "building:levels", "addr:housenumber", "addr:street", "geometry"] if c in gdf.columns]
    trimmed = gdf[keep_cols].copy()
    trimmed = trimmed.reset_index(drop=True)
    trimmed.to_file(out_path, driver="GeoJSON")
    print(f"[buildings] wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")


def walkways_to_geojson(graph, out_path):
    edges_gdf = ox.graph_to_gdfs(graph, nodes=False, edges=True)
    keep_cols = [c for c in ["name", "highway", "length", "geometry"] if c in edges_gdf.columns]
    trimmed = edges_gdf[keep_cols].copy()
    trimmed = trimmed.reset_index(drop=True)
    trimmed.to_file(out_path, driver="GeoJSON")
    print(f"[walkways] wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    buildings_gdf = extract_buildings()
    buildings_to_geojson(buildings_gdf, OUTPUT_DIR / "buildings.geojson")

    walk_graph = extract_walkways()
    walkways_to_geojson(walk_graph, OUTPUT_DIR / "walkways.geojson")

    # Sanity-check summary so whoever runs this can eyeball it before the
    # rest of the team builds on top of the output (Section 6.5's "confirm
    # the query resolves to a sensible boundary" instruction).
    named = buildings_gdf["name"].notna().sum() if "name" in buildings_gdf.columns else 0
    print(f"\nSummary: {len(buildings_gdf)} buildings extracted, {named} have a 'name' tag.")
    print("Cross-check a handful of named buildings against maps.bu.edu before relying on this data.")


if __name__ == "__main__":
    sys.exit(main())
