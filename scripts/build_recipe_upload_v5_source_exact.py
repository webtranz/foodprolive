import csv
import importlib.util
import json
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "artifacts" / "recipe-upload-source"
INPUT_CSV = ROOT / "artifacts" / "recipe-upload-one-go-v3" / "UPLOAD-THIS-RECIPES-KBR-384-102-MAPPED-V3.csv"
OUT_DIR = ROOT / "artifacts" / "recipe-upload-one-go-v5-source-exact"
OUTPUT_CSV = OUT_DIR / "UPLOAD-THIS-RECIPES-KBR-384-102-SOURCE-EXACT-1SERVING-V5.csv"
SOURCE_AUDIT_CSV = OUT_DIR / "source-exact-ingredients-by-recipe-v5.csv"
MISSING_CSV = OUT_DIR / "missing-source-ingredients-to-add-first-v5.csv"
QC_CSV = OUT_DIR / "recipe-upload-v5-qc-summary.csv"
WATER_AUDIT_CSV = OUT_DIR / "water-coverage-v5.csv"
PLAIN_WATER_ITEM_CODE = "224894"
WEIGHT_MASTER_UNITS = {"kg", "g"}
PACKAGE_UNITS = {"ea", "pak", "pkt", "pack", "packet", "cs", "case"}
PIECE_WEIGHT_GRAMS_BY_ITEM_CODE = {
    "PR000018": 5,      # garlic clove
    "PR000016": 8,      # green chilli
    "PR000090": 100,    # lemon
    "PR000072": 150,    # apple
    "PR000078": 75,     # kiwi
    "PR000092": 150,    # orange
    "GR003481": 5,      # cinnamon stick
    "GR003571": 0.2,    # cardamom pod
    "GR003482": 0.1,    # clove
    "147040": 0.2,      # bay leaf
    "147047": 10,       # dried lime
}


def load_converter():
    path = ROOT / "scripts" / "convert_recipe_docs_to_upload.py"
    spec = importlib.util.spec_from_file_location("recipe_converter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


conv = load_converter()


def normalize(value):
    value = str(value or "").lower()
    value = re.sub(r"\bkbr\s*[- ]?\s*384\b", " ", value)
    value = re.sub(r"\bonego\s*v?\d*\b", " ", value)
    value = re.sub(r"\b(recipe|ingredients?|scaled|servings?|portions?|pax|for|items?)\b", " ", value)
    value = re.sub(r"\([^)]*\)", " ", value)
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def tokens(value):
    stop = {"and", "with", "the", "of", "or", "style", "classic", "recipe", "kbr", "onego"}
    return {token for token in normalize(value).split() if token and token not in stop}


def canonical_food_key(value):
    key = conv.canonical_ingredient_key(value)
    replacements = {
        "apples": "apple",
        "oranges": "orange",
        "strawberries": "strawberry",
        "blueberries": "blueberry",
        "kiwis": "kiwi",
        "cloves": "clove",
        "lentils": "lentil",
        "tomatoes": "tomato",
        "pineapples": "pineapple",
        "vegetables": "vegetable",
        "peppers": "pepper",
        "pickles": "pickle",
        "raisins": "raisin",
        "almonds": "almond",
        "cashews": "cashew",
        "cucumbers": "cucumber",
        "pistachios": "pistachio",
        "breadcrumbs": "bread crumb",
        "cornstarch": "corn starch",
        "cornflour": "corn flour",
        "buttermilk": "butter milk",
        "peppercorns": "pepper",
    }
    return " ".join(replacements.get(token, token) for token in key.split())


def exact_phrase_in_key(phrase, key):
    phrase_tokens = canonical_food_key(phrase).split()
    key_tokens = canonical_food_key(key).split()
    if not phrase_tokens or not key_tokens:
        return False
    for index in range(0, len(key_tokens) - len(phrase_tokens) + 1):
        if key_tokens[index:index + len(phrase_tokens)] == phrase_tokens:
            return True
    return len(phrase_tokens) == 1 and phrase_tokens[0] in key_tokens


def ranked_doc_matches(recipe_name, docs):
    recipe_norm = normalize(recipe_name)
    recipe_tokens = tokens(recipe_name)
    scored = []
    for path in docs:
        doc_name = conv.clean_recipe_name(path)
        doc_norm = normalize(doc_name)
        doc_tokens = tokens(doc_name)
        ratio = SequenceMatcher(None, recipe_norm, doc_norm).ratio()
        overlap = len(recipe_tokens & doc_tokens) / max(1, len(recipe_tokens | doc_tokens))
        containment = 0.15 if (doc_norm and doc_norm in recipe_norm) or (recipe_norm and recipe_norm in doc_norm) else 0
        scored.append((ratio + overlap + containment, ratio, overlap, path))
    return sorted(scored, reverse=True, key=lambda item: item[0])


def is_plain_water_text(value):
    key = canonical_food_key(value)
    if "water" not in key.split():
        return False
    excluded = ("rose water", "kewra water", "orange blossom water", "watermelon")
    return not any(phrase in key for phrase in excluded)


def source_lines(paragraphs, tables):
    for paragraph in paragraphs:
        yield paragraph
    for table in tables:
        for row in table:
            yield " | ".join(cell for cell in row if str(cell or "").strip())


def rice_quantity_kg(ingredients):
    total = 0.0
    for line in ingredients:
        key = canonical_food_key(line.get("ingredient_name"))
        unit = str(line.get("unit") or "").lower()
        quantity = float(line.get("quantity") or 0)
        if "rice" not in key.split() or quantity <= 0:
            continue
        if unit == "kg":
            total += quantity
        elif unit == "g":
            total += quantity / 1000
    return total


def supplemental_water_lines(paragraphs, tables, ingredients):
    if any(is_plain_water_text(line.get("ingredient_name")) for line in ingredients):
        return []

    rice_kg = rice_quantity_kg(ingredients)
    additions = []
    seen_text = set()
    for text in source_lines(paragraphs, tables):
        normalized = re.sub(r"\s+", " ", str(text or "")).strip()
        lowered = normalized.lower()
        if not normalized or normalized in seen_text or not is_plain_water_text(normalized):
            continue
        seen_text.add(normalized)
        if "as required" not in lowered and "as needed" not in lowered:
            continue

        ratio = re.search(r"(\d+(?:\.\d+)?)\s*:\s*1\s+ratio", lowered)
        if ratio and rice_kg > 0:
            quantity = rice_kg * float(ratio.group(1))
            note = f"{normalized} | derived from {ratio.group(1)}:1 rice-water ratio"
        elif "boiling" in lowered and rice_kg > 0:
            quantity = rice_kg * 2
            note = f"{normalized} | derived from 2:1 rice-water boiling ratio"
        else:
            continue

        additions.append({
            "ingredient_name": "Water",
            "quantity": format_qty(quantity),
            "unit": "l",
            "_source_note": note,
        })
    return additions


def extract_ingredients_exact(paragraphs, tables):
    ingredients = conv.extract_ingredients(paragraphs, tables)
    ingredients.extend(supplemental_water_lines(paragraphs, tables, ingredients))
    deduped = []
    seen = set()
    for line in ingredients:
        if not line.get("ingredient_name") or float(line.get("quantity") or 0) <= 0:
            continue
        key = (
            canonical_food_key(line.get("ingredient_name")),
            round(float(line.get("quantity") or 0), 6),
            str(line.get("unit") or "").lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(line)
    return deduped


def load_catalog():
    catalog = conv.load_ingredient_catalog()
    by_code = {}
    for item in catalog:
        code = str(item.get("item_code") or "").strip().lower()
        if code and code not in by_code:
            by_code[code] = item
    return catalog, by_code


def match_ingredient(line, catalog, code_map):
    key = canonical_food_key(line.get("ingredient_name"))
    if not key:
        return None, "blank"

    preferred_codes = sorted(
        conv.PREFERRED_ITEM_CODES,
        key=lambda pair: len(canonical_food_key(pair[0]).split()),
        reverse=True,
    )
    for phrase, item_code in preferred_codes:
        if exact_phrase_in_key(phrase, key):
            match = code_map.get(str(item_code).lower())
            if match:
                return match, "preferred_phrase"

    special_phrases = (
        ("baking soda", "182376"),
        ("dill pickle", "267491"),
        ("pickle", "267491"),
        ("raisin", "404314"),
        ("golden raisin", "404314"),
        ("sultana", "404314"),
        ("almond", "404350"),
        ("slivered almond", "404350"),
        ("pistachio", "404353"),
        ("cucumber", "PR000010"),
        ("corn flour", "139554"),
        ("cornflour", "139554"),
        ("black peppercorn", "185836"),
        ("bell pepper", "PR000009"),
        ("sweet bell pepper", "PR000009"),
        ("mixed vegetable", "404332"),
        ("charcoal", "263304"),
    )
    for phrase, item_code in special_phrases:
        if exact_phrase_in_key(phrase, key):
            match = code_map.get(str(item_code).lower())
            if match:
                return match, "preferred_phrase"

    exact = [item for item in catalog if canonical_food_key(item.get("ingredient_name")) == key]
    if len(exact) == 1:
        return exact[0], "exact"

    key_tokens = set(key.split())
    candidates = []
    for item in catalog:
        item_key = canonical_food_key(item.get("ingredient_name"))
        item_tokens = set(item_key.split())
        overlap = len(key_tokens & item_tokens)
        if overlap:
            score = overlap / max(1, len(key_tokens | item_tokens))
            candidates.append((score, item))
    candidates.sort(reverse=True, key=lambda item: item[0])
    if candidates and candidates[0][0] >= 0.45:
        if len(candidates) == 1 or candidates[0][0] > candidates[1][0]:
            return candidates[0][1], "word_overlap"
    return None, "unmatched"


def format_qty(value):
    value = round(float(value), 6)
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return float(text) if "." in text else int(text)


def scale_to_one_serving(ingredients, servings):
    factor = 1 / max(1, float(servings or 1))
    scaled = []
    for ingredient in ingredients:
        line = dict(ingredient)
        line["quantity"] = format_qty(float(line.get("quantity") or 0) * factor)
        scaled.append(line)
    return scaled


def convert_recipe_quantity_for_upload(line, matched_ingredient=None):
    converted = dict(line)
    quantity = float(converted.get("quantity") or 0)
    unit = str(converted.get("unit") or "").strip().lower()
    ingredient_unit = str((matched_ingredient or {}).get("unit") or "").strip().lower()
    item_code = str(converted.get("item_code") or (matched_ingredient or {}).get("item_code") or "").strip()
    ingredient_name = str(
        converted.get("ingredient_name")
        or (matched_ingredient or {}).get("ingredient_name")
        or ""
    )
    weight_packaged = ingredient_unit in PACKAGE_UNITS and re.search(
        r"/\s*\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|grams)\b",
        ingredient_name,
        re.I,
    )

    if unit == "kg":
        converted["quantity"] = format_qty(quantity * 1000)
        converted["unit"] = "g"
    elif unit == "bdl" or (ingredient_unit == "bdl" and unit in {"pieces", "piece", "bunch", "bunches"}):
        converted["quantity"] = format_qty(quantity * 80)
        converted["unit"] = "g"
    elif ingredient_unit in WEIGHT_MASTER_UNITS or weight_packaged:
        if unit == "l":
            converted["quantity"] = format_qty(quantity * 1000)
            converted["unit"] = "g"
        elif unit == "ml":
            converted["quantity"] = format_qty(quantity)
            converted["unit"] = "g"
        elif unit in {"pieces", "piece", "bunch", "bunches"} and item_code in PIECE_WEIGHT_GRAMS_BY_ITEM_CODE:
            converted["quantity"] = format_qty(quantity * PIECE_WEIGHT_GRAMS_BY_ITEM_CODE[item_code])
            converted["unit"] = "g"

    return converted


def upload_ingredient_payloads(ingredients):
    return [
        {key: value for key, value in line.items() if not str(key).startswith("_")}
        for line in ingredients
    ]


def missing_item_code(name, existing_count):
    slug = re.sub(r"[^A-Z0-9]+", "", str(name or "").upper())[:8] or "ITEM"
    return f"RCPMIS-V5-{existing_count + 1:03d}-{slug}"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    catalog, code_map = load_catalog()
    docs = sorted(path for path in SOURCE_DIR.rglob("*.docx") if not path.name.startswith("~$"))
    source_cache = {}

    with INPUT_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        headers = list(reader.fieldnames or [])

    output_rows = []
    source_audit_rows = []
    water_audit_rows = []
    qc_rows = []
    missing_rows = {}
    match_counts = Counter()

    for row in rows:
        ranked = ranked_doc_matches(row["name"], docs)
        selected = None
        for candidate in ranked[:10]:
            source_path = candidate[3]
            if source_path not in source_cache:
                paragraphs, tables = conv.docx_text_and_tables(source_path)
                source_cache[source_path] = {
                    "paragraphs": paragraphs,
                    "servings": conv.extract_servings(source_path, paragraphs),
                    "ingredients": extract_ingredients_exact(paragraphs, tables),
                    "instructions": conv.extract_instructions(paragraphs),
                    "prep_time_minutes": conv.extract_time(paragraphs, "prep"),
                    "cook_time_minutes": conv.extract_time(paragraphs, "cook"),
                }
            if source_cache[source_path]["ingredients"]:
                selected = candidate
                break
        if selected is None:
            selected = ranked[0]

        score, ratio, overlap, source_path = selected
        source = source_cache[source_path]
        source_servings = source["servings"] or float(row.get("servings") or 1) or 1
        rebuilt = []
        per_recipe_missing = 0

        for source_index, source_line in enumerate(source["ingredients"], 1):
            match, status = match_ingredient(source_line, catalog, code_map)
            clean_line = dict(source_line)
            if match:
                clean_line["ingredient_name"] = match["ingredient_name"]
                clean_line["item_code"] = match["item_code"]
                clean_line["ingredient_id"] = ""
                clean_line = convert_recipe_quantity_for_upload(clean_line, match)
            else:
                clean_line = convert_recipe_quantity_for_upload(clean_line)
                miss_key = canonical_food_key(clean_line["ingredient_name"])
                if miss_key not in missing_rows:
                    item_code = missing_item_code(clean_line["ingredient_name"], len(missing_rows))
                    missing_rows[miss_key] = {
                        "item_code": item_code,
                        "name": clean_line["ingredient_name"],
                        "ingredient_code": item_code,
                        "sku": item_code,
                        "alias": "",
                        "supplier_item_name": clean_line["ingredient_name"],
                        "unit": clean_line.get("unit") or "kg",
                        "category": row.get("category") or "Recipe Ingredients",
                        "cuisine_type": "",
                        "cost_per_unit": "0",
                        "calories_per_100g": "",
                        "protein_per_100g": "",
                        "carbs_per_100g": "",
                        "fat_per_100g": "",
                        "sodium_per_100g": "",
                        "sugar_per_100g": "",
                        "cooking_yield_percent": "100",
                        "shrinkage_percent": "0",
                        "raw_weight_per_unit": "",
                        "cooked_weight_per_unit": "",
                        "allergens": "none",
                        "is_active": "true",
                    }
                clean_line["item_code"] = missing_rows[miss_key]["item_code"]
                clean_line["ingredient_id"] = ""
                per_recipe_missing += 1
            rebuilt.append(clean_line)
            match_counts[status] += 1

        scaled = scale_to_one_serving(rebuilt, source_servings)
        for source_index, (source_line, scaled_line) in enumerate(zip(source["ingredients"], scaled), 1):
            source_note = source_line.get("_source_note", "")
            source_audit_rows.append({
                "recipe_name": row["name"],
                "recipe_code": row["recipe_code"],
                "source_file": str(source_path),
                "source_line_no": source_index,
                "source_ingredient_name": source_line.get("ingredient_name", ""),
                "source_quantity": source_line.get("quantity", ""),
                "source_unit": source_line.get("unit", ""),
                "source_servings": source_servings,
                "upload_ingredient_name": scaled_line.get("ingredient_name", ""),
                "upload_item_code": scaled_line.get("item_code", ""),
                "upload_quantity_for_1_serving": scaled_line.get("quantity", ""),
                "upload_unit": scaled_line.get("unit", ""),
                "match_status": "mapped" if scaled_line.get("ingredient_id", "") == "" and not str(scaled_line.get("item_code", "")).startswith("RCPMIS-V5") else "missing_master",
                "source_note": source_note,
            })
            if is_plain_water_text(source_line.get("ingredient_name")):
                water_audit_rows.append({
                    "recipe_name": row["name"],
                    "recipe_code": row["recipe_code"],
                    "source_file": str(source_path),
                    "source_water_text_or_note": source_note or source_line.get("ingredient_name", ""),
                    "source_quantity": source_line.get("quantity", ""),
                    "source_unit": source_line.get("unit", ""),
                    "source_servings": source_servings,
                    "upload_item_code": scaled_line.get("item_code", ""),
                    "upload_quantity_for_1_serving": scaled_line.get("quantity", ""),
                    "upload_unit": scaled_line.get("unit", ""),
                })

        clean = dict(row)
        clean["servings"] = "1"
        clean["ingredients"] = json.dumps(upload_ingredient_payloads(scaled), ensure_ascii=False)
        clean["site_scope"] = "specific"
        clean["site_ids"] = json.dumps(["KBR-384"])
        clean["site_names"] = json.dumps(["KBR"])
        if source["instructions"]:
            clean["instructions"] = source["instructions"]
        clean["prep_time_minutes"] = source["prep_time_minutes"]
        clean["cook_time_minutes"] = source["cook_time_minutes"]
        output_rows.append(clean)

        qc_rows.append({
            "recipe_name": row["name"],
            "recipe_code": row["recipe_code"],
            "matched_source_file": str(source_path),
            "source_servings": source_servings,
            "source_ingredient_count": len(source["ingredients"]),
            "upload_ingredient_count": len(scaled),
            "missing_master_count": per_recipe_missing,
            "match_score": round(score, 4),
            "name_similarity": round(ratio, 4),
            "token_overlap": round(overlap, 4),
            "needs_review": "YES" if score < 0.65 or not scaled or per_recipe_missing else "",
        })

    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(output_rows)

    ingredient_headers = [
        "item_code", "name", "ingredient_code", "sku", "alias", "supplier_item_name", "unit",
        "category", "cuisine_type", "cost_per_unit", "calories_per_100g", "protein_per_100g",
        "carbs_per_100g", "fat_per_100g", "sodium_per_100g", "sugar_per_100g",
        "cooking_yield_percent", "shrinkage_percent", "raw_weight_per_unit",
        "cooked_weight_per_unit", "allergens", "is_active",
    ]
    with MISSING_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=ingredient_headers)
        writer.writeheader()
        writer.writerows(missing_rows.values())

    with SOURCE_AUDIT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name", "recipe_code", "source_file", "source_line_no", "source_ingredient_name",
            "source_quantity", "source_unit", "source_servings", "upload_ingredient_name",
            "upload_item_code", "upload_quantity_for_1_serving", "upload_unit", "match_status",
            "source_note",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(source_audit_rows)

    with WATER_AUDIT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name", "recipe_code", "source_file", "source_water_text_or_note",
            "source_quantity", "source_unit", "source_servings", "upload_item_code",
            "upload_quantity_for_1_serving", "upload_unit",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(water_audit_rows)

    with QC_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name", "recipe_code", "matched_source_file", "source_servings",
            "source_ingredient_count", "upload_ingredient_count", "missing_master_count",
            "match_score", "name_similarity", "token_overlap", "needs_review",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(qc_rows)

    print(json.dumps({
        "recipes": len(output_rows),
        "source_ingredient_lines": len(source_audit_rows),
        "missing_master_ingredients": len(missing_rows),
        "match_counts": dict(match_counts),
        "output": str(OUTPUT_CSV),
        "missing": str(MISSING_CSV),
        "audit": str(SOURCE_AUDIT_CSV),
        "water_audit": str(WATER_AUDIT_CSV),
        "qc": str(QC_CSV),
    }, indent=2))


if __name__ == "__main__":
    main()
