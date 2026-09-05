import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("conv", ROOT / "scripts" / "convert_recipe_docs_to_upload.py")
conv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conv)

for rel in [
    "artifacts/recipe-upload-source/MENU/MENU/Dall/Dal Mash Fry.100 pax.docx",
    "artifacts/recipe-upload-source/MENU/MENU/Dall/Dall Mash 100 pax .docx",
]:
    path = ROOT / rel
    paragraphs, tables = conv.docx_text_and_tables(path)
    print("---", path)
    print("servings", conv.extract_servings(path, paragraphs))
    print("parsed", conv.extract_ingredients(paragraphs, tables))
    print("paragraphs")
    for paragraph in paragraphs[:80]:
        print(paragraph)
