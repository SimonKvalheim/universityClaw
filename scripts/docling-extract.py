#!/usr/bin/env python3
"""Standalone document extraction script using Docling."""

import argparse
import json
import os
import sys
from pathlib import Path


def extract(input_file: str, output_dir: str) -> dict:
    from docling.document_converter import DocumentConverter

    input_path = Path(input_file)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    figures_dir = output_path / "figures"
    figures_dir.mkdir(exist_ok=True)

    converter = DocumentConverter()
    result = converter.convert(str(input_path))
    doc = result.document

    # Export markdown
    markdown = doc.export_to_markdown()
    (output_path / "content.md").write_text(markdown, encoding="utf-8")

    # Save figures
    figure_filenames = []
    for idx, (element, _level) in enumerate(doc.iterate_items()):
        element_type = type(element).__name__
        if element_type in ("PictureItem", "FigureItem"):
            for img_idx, image in enumerate(getattr(element, "images", []) or []):
                try:
                    ext = "png"
                    fname = f"figure_{idx}_{img_idx}.{ext}"
                    fpath = figures_dir / fname
                    if hasattr(image, "save"):
                        image.save(str(fpath))
                    elif hasattr(image, "pil_image") and image.pil_image is not None:
                        image.pil_image.save(str(fpath))
                    else:
                        continue
                    figure_filenames.append(fname)
                except Exception:
                    pass

    # Count pages
    pages = None
    try:
        pages = len(doc.pages) if doc.pages else None
    except Exception:
        pass

    # Detect format from extension
    suffix = input_path.suffix.lower().lstrip(".")
    format_map = {
        "pdf": "PDF",
        "pptx": "PPTX",
        "ppt": "PPT",
        "docx": "DOCX",
        "doc": "DOC",
        "png": "PNG",
        "jpg": "JPEG",
        "jpeg": "JPEG",
        "tiff": "TIFF",
        "bmp": "BMP",
        "md": "Markdown",
        "txt": "Text",
        "html": "HTML",
        "htm": "HTML",
    }
    doc_format = format_map.get(suffix, suffix.upper())

    metadata = {
        "source": str(input_path.resolve()),
        "pages": pages,
        "figures": figure_filenames,
        "format": doc_format,
    }
    (output_path / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )

    return {"status": "ok", "outputDir": str(output_path.resolve())}


def main():
    parser = argparse.ArgumentParser(description="Extract document content via Docling")
    parser.add_argument("input_file", help="Path to the input document")
    parser.add_argument("output_dir", help="Directory to write output files")
    args = parser.parse_args()

    try:
        result = extract(args.input_file, args.output_dir)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
