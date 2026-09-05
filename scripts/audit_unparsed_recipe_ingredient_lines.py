import importlib.util
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "artifacts" / "recipe-upload-source"
OUT_PATH = ROOT / "artifacts" / "recipe-upload-one-go-v5-source-exact" / "unparsed-source-ingredient-lines.json"


def load_converter():
    path = ROOT / "scripts" / "convert_recipe_docs_to_upload.py"
    spec = importlib.util.spec_from_file_location("recipe_converter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


conv = load_converter()


def looks_like_possible_ingredient(text):
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(value) < 3:
        return False
    lowered = value.lower()
    reject = (
        "instruction", "method", "preparation", "nutrition", "allergen", "reviewed",
        "executive chef", "tick the", "serving:", "dish name:", "notes:",
        "food safety", "storage", "yield:", "total amount", "nutrient",
    )
    if any(term in lowered for term in reject):
        return False
    return bool(re.search(r"\d", value)) or any(word in lowered for word in (
        "salt", "pepper", "spice", "masala", "coriander", "chilli", "chili",
        "turmeric", "cumin", "garlic", "ginger", "herb", "parsley", "dill",
        "saffron", "curry leaves", "onion", "tomato", "oil", "ghee",
    ))


def main():
    rows = []
    for path in sorted(SOURCE_DIR.rglob("*.docx")):
        if path.name.startswith("~$"):
            continue
        paragraphs, tables = conv.docx_text_and_tables(path)
        parsed_keys = {
            conv.normalize_key(line["ingredient_name"])
            for line in conv.extract_ingredients(paragraphs, tables)
        }

        for table_index, table in enumerate(tables, 1):
            for row_index, table_row in enumerate(table, 1):
                joined = " | ".join(table_row)
                if conv.parse_ingredient_line(joined):
                    continue
                if looks_like_possible_ingredient(joined):
                    rows.append({
                        "recipe_name": conv.clean_recipe_name(path),
                        "source_file": str(path),
                        "source_area": f"table {table_index} row {row_index}",
                        "text": joined,
                        "reason": "table row did not parse as quantity ingredient",
                    })

        in_section = False
        for paragraph_index, paragraph in enumerate(paragraphs, 1):
            lowered = paragraph.lower()
            if any(marker in lowered for marker in conv.INGREDIENT_MARKERS):
                in_section = True
            elif in_section and conv.is_stop_section(paragraph):
                in_section = False
            if not in_section:
                continue
            parsed = conv.parse_ingredient_line(paragraph)
            if parsed:
                continue
            if looks_like_possible_ingredient(paragraph):
                clean = re.sub(r"^ingredient\s*:\s*", "", paragraph, flags=re.I)
                key = conv.normalize_key(clean)
                if key not in parsed_keys:
                    rows.append({
                        "recipe_name": conv.clean_recipe_name(path),
                        "source_file": str(path),
                        "source_area": f"paragraph {paragraph_index}",
                        "text": paragraph,
                        "reason": "ingredient-section text did not include parseable quantity",
                    })

    OUT_PATH.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({
        "unparsed_possible_ingredient_lines": len(rows),
        "output": str(OUT_PATH),
    }, indent=2))


if __name__ == "__main__":
    main()
