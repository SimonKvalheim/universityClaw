#!/usr/bin/env python3
"""Standalone document extraction script using Docling."""

import argparse
import json
import os
import sys
from pathlib import Path


def extract(input_file: str, output_dir: str) -> dict:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    input_path = Path(input_file)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    figures_dir = output_path / "figures"
    figures_dir.mkdir(exist_ok=True)

    pipeline_options = PdfPipelineOptions(
        generate_picture_images=True,
        generate_page_images=True,
        images_scale=2.0,
    )

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
            ),
        }
    )
    result = converter.convert(str(input_path))
    doc = result.document

    # Export markdown with location markers via iterate_items()
    markdown_parts = []
    figure_filenames = []

    for idx, (element, _level) in enumerate(doc.iterate_items()):
        element_type = type(element).__name__

        # Extract page number if available
        page_num = None
        if hasattr(element, 'prov') and element.prov:
            for prov in element.prov:
                if hasattr(prov, 'page_no'):
                    page_num = prov.page_no
                    break

        # Build location marker
        marker_parts = []
        if page_num is not None:
            marker_parts.append(f"page:{page_num}")
        if hasattr(element, 'label'):
            marker_parts.append(f"label:{element.label}")

        marker = ""
        if marker_parts:
            marker = f"<!-- {' '.join(marker_parts)} -->\n"

        # Handle figures separately
        if element_type in ("PictureItem", "FigureItem"):
            try:
                pil_img = element.get_image(doc)
                if pil_img is not None:
                    fname = f"figure_{idx}.png"
                    fpath = figures_dir / fname
                    pil_img.save(str(fpath))
                    figure_filenames.append(fname)

                    # Include figure reference in markdown
                    caption = ""
                    if hasattr(element, "caption_text"):
                        caption = element.caption_text(doc) or ""
                    alt = caption or f"Figure {len(figure_filenames)}"
                    markdown_parts.append(
                        f"{marker}![{alt}](figures/{fname})\n"
                    )
            except Exception as e:
                print(f"Warning: failed to extract figure at index {idx}: {e}", file=sys.stderr)
            continue

        # Get text content
        text = ""
        if hasattr(element, 'text') and element.text:
            text = element.text
        elif hasattr(element, 'export_to_markdown'):
            try:
                text = element.export_to_markdown()
            except Exception:
                pass

        if not text:
            continue

        # Format based on element type
        if element_type in ("SectionHeaderItem",):
            level = getattr(element, 'level', 1)
            prefix = "#" * min(level + 1, 6)
            markdown_parts.append(f"{marker}{prefix} {text}\n")
        else:
            markdown_parts.append(f"{marker}{text}\n")

    markdown = "\n".join(markdown_parts)

    # Fallback: if iterate_items produced nothing, use export_to_markdown
    if not markdown.strip():
        markdown = doc.export_to_markdown()

    (output_path / "content.md").write_text(markdown, encoding="utf-8")

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

    # Convert DOCX/PPTX to PDF for preview (non-fatal)
    if suffix in ("docx", "pptx", "doc", "ppt"):
        try:
            import subprocess

            result_pdf = subprocess.run(
                [
                    "soffice",
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(output_path),
                    str(input_path.resolve()),
                ],
                capture_output=True,
                timeout=120,
            )
            if result_pdf.returncode == 0:
                # soffice names the output after the input stem
                generated = output_path / (input_path.stem + ".pdf")
                if generated.exists():
                    generated.rename(output_path / "preview.pdf")
        except Exception:
            pass

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
