"""Copy Kenney Mini Characters GLBs into public/models with their texture embedded.

Kenney's GLBs point at an external Textures/colormap.png; embedding it makes each model a
single self-contained file, so the browser never has to resolve a relative texture URL.

    python3 map-client/scripts/embed_glb_textures.py "<unzipped kenney pack>/Models/GLB format"
"""

import json
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "models"


def pad4(data, fill):
    return data + fill * (-len(data) % 4)


def embed(glb_path: Path, out_path: Path):
    raw = glb_path.read_bytes()
    json_len = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20 : 20 + json_len])
    bin_off = 20 + json_len
    bin_len = struct.unpack_from("<I", raw, bin_off)[0]
    binary = bytearray(raw[bin_off + 8 : bin_off + 8 + bin_len])

    for image in gltf.get("images", []):
        uri = image.pop("uri", None)
        if uri is None:
            continue
        png = (glb_path.parent / uri).read_bytes()
        binary = bytearray(pad4(bytes(binary), b"\0"))
        gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(png)})
        image["bufferView"] = len(gltf["bufferViews"]) - 1
        image["mimeType"] = "image/png"
        binary += png

    # Kenney tags every texture with a KHR_texture_transform that only says texCoord 0 (a no-op).
    # loaders.gl bakes that into a new TEXCOORD_2, which luma.gl then refuses to sample, so the
    # characters render untextured grey. Dropping the identity transform keeps the plain UVs.
    for material in gltf.get("materials", []):
        info = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        transform = (info or {}).get("extensions", {}).pop("KHR_texture_transform", None)
        if transform is not None:
            info["texCoord"] = transform.get("texCoord", 0)
            if not info["extensions"]:
                del info["extensions"]
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in gltf:
            gltf[key] = [e for e in gltf[key] if e != "KHR_texture_transform"]
            if not gltf[key]:
                del gltf[key]

    binary = pad4(bytes(binary), b"\0")
    gltf["buffers"][0]["byteLength"] = len(binary)
    json_chunk = pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    out_path.write_bytes(out)


def main():
    src = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for glb in sorted(src.glob("*.glb")):
        embed(glb, OUT / glb.name)
        print(glb.name)


if __name__ == "__main__":
    main()
