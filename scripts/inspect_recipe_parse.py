import importlib.util
import sys
from pathlib import Path


def load_converter():
    spec = importlib.util.spec_from_file_location("conv", "scripts/convert_recipe_docs_to_upload.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    needle = " ".join(sys.argv[1:]).lower() if len(sys.argv) > 1 else ""
    conv = load_converter()
    docs = sorted(Path("artifacts/recipe-upload-source").rglob("*.docx"))
    matches = [path for path in docs if needle in path.name.lower()]
    if not matches:
        raise SystemExit(f"No source doc matched: {needle}")
    path = matches[0]
    paragraphs, tables = conv.docx_text_and_tables(path)
    print(path)
    print("TABLES")
    for table_index, table in enumerate(tables):
        print("TABLE", table_index)
        for row in table[:40]:
            print(row)
    print("PARAGRAPHS")
    for paragraph in paragraphs[:100]:
        print(paragraph)
    print("PARSED")
    for line in conv.extract_ingredients(paragraphs, tables):
        print(line)


if __name__ == "__main__":
    main()
