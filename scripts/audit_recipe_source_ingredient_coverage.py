import importlib.util
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "artifacts" / "recipe-upload-source"
OUT_PATH = ROOT / "artifacts" / "recipe-upload-one-go-v5-source-exact" / "source-ingredient-coverage-diagnostics.json"


def load_converter():
    path = ROOT / "scripts" / "convert_recipe_docs_to_upload.py"
    spec = importlib.util.spec_from_file_location("recipe_converter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


conv = load_converter()


def split_inline_ingredient_list(text):
    if ":" not in text:
        return []
    label, body = text.split(":", 1)
    if "ingredient" not in label.lower():
        return []
    pieces = re.split(r"\s*[-–—•]\s*", body)
    cleaned = []
    for piece in pieces:
        piece = re.sub(r"\s+", " ", piece).strip(" .,:;")
        if len(piece) < 2:
            continue
        if re.search(r"\d", piece):
            continue
        if piece.lower().startswith(("chef ", "notes", "allergens", "free of")):
            continue
        cleaned.append(piece)
    return cleaned


def main():
    diagnostics = []
    for path in sorted(SOURCE_DIR.rglob("*.docx")):
        if path.name.startswith("~$"):
            continue
        paragraphs, tables = conv.docx_text_and_tables(path)
        parsed = conv.extract_ingredients(paragraphs, tables)
        inline_only = []
        for paragraph in paragraphs:
            inline_only.extend(split_inline_ingredient_list(paragraph))
        diagnostics.append({
            "file": str(path),
            "recipe_name": conv.clean_recipe_name(path),
            "parsed_count": len(parsed),
            "inline_ingredient_names_without_quantities": inline_only,
            "paragraphs_with_ingredient_word": [
                p for p in paragraphs if "ingredient" in p.lower()
            ],
            "table_count": len(tables),
            "table_shapes": [f"{len(t)}x{max((len(r) for r in t), default=0)}" for t in tables],
        })

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(diagnostics, indent=2, ensure_ascii=False), encoding="utf-8")
    summary = {
        "documents": len(diagnostics),
        "documents_with_zero_parsed": sum(1 for row in diagnostics if row["parsed_count"] == 0),
        "documents_with_inline_unquantified": sum(
            1 for row in diagnostics if row["inline_ingredient_names_without_quantities"]
        ),
        "inline_unquantified_names": sum(
            len(row["inline_ingredient_names_without_quantities"]) for row in diagnostics
        ),
        "output": str(OUT_PATH),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
