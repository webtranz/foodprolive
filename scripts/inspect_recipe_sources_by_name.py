import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("conv", ROOT / "scripts" / "convert_recipe_docs_to_upload.py")
conv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conv)

needle = " ".join(sys.argv[1:]).lower()
for path in sorted((ROOT / "artifacts" / "recipe-upload-source").rglob("*.docx")):
    name = conv.clean_recipe_name(path)
    if needle and needle not in name.lower() and needle not in str(path).lower():
        continue
    paragraphs, tables = conv.docx_text_and_tables(path)
    print(f"\n--- {name}")
    print(path)
    print("servings", conv.extract_servings(path, paragraphs))
    print("parsed", len(conv.extract_ingredients(paragraphs, tables)), conv.extract_ingredients(paragraphs, tables))
    print("paragraphs")
    for index, paragraph in enumerate(paragraphs[:120], 1):
        print(f"{index}: {paragraph.encode('ascii', 'replace').decode('ascii')}")
    print("tables")
    for table_index, table in enumerate(tables, 1):
        print(f"table {table_index}")
        for row in table[:40]:
            print([cell.encode('ascii', 'replace').decode('ascii') for cell in row])
