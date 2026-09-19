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
OUT_DIR = ROOT / "artifacts" / "recipe-upload-one-go-v4-clean"
OUTPUT_CSV = OUT_DIR / "UPLOAD-THIS-RECIPES-KBR-384-102-CLEAN-1SERVING.csv"
REMOVED_CSV = OUT_DIR / "removed-ingredients-by-recipe.csv"
QC_CSV = OUT_DIR / "recipe-cleanup-qc-summary.csv"
MISSING_CSV = OUT_DIR / "missing-source-ingredients-to-add-first.csv"
SOURCE_AUDIT_CSV = OUT_DIR / "source-exact-ingredients-by-recipe.csv"


def load_converter():
    path = ROOT / "scripts" / "convert_recipe_docs_to_upload.py"
    spec = importlib.util.spec_from_file_location("recipe_converter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


conv = load_converter()


def extract_ingredients_exact(paragraphs, tables):
    ingredients = []
    for table in tables:
        header_index = None
        for index, row in enumerate(table[:3]):
            joined = " ".join(row).lower()
            if "ingredient" in joined and ("quantity" in joined or "metric" in joined):
                header_index = index
                break
        if header_index is None:
            continue
        header = [conv.normalize_key(cell) for cell in table[header_index]]
        try:
            ingredient_col = next(i for i, cell in enumerate(header) if "ingredient" in cell)
        except StopIteration:
            ingredient_col = 0
        quantity_col = 1 if len(header) > 1 else 0
        for i, cell in enumerate(header):
            if "quantity" in cell or "metric" in cell or "amount" in cell:
                quantity_col = i
                break
        for row in table[header_index + 1:]:
            if ingredient_col >= len(row) or quantity_col >= len(row):
                continue
            parsed = conv.parse_ingredient_line(f"{row[ingredient_col]}: {row[quantity_col]}")
            if parsed:
                ingredients.append(parsed)

    in_ingredient_section = False
    for paragraph in paragraphs:
        lowered = paragraph.lower()
        if any(marker in lowered for marker in conv.INGREDIENT_MARKERS):
            in_ingredient_section = True
            continue
        if not in_ingredient_section:
            continue
        parsed = conv.parse_ingredient_line(paragraph)
        if parsed:
            ingredients.append(parsed)
            continue
        if conv.is_stop_section(paragraph):
            in_ingredient_section = False

    if not ingredients:
        for paragraph in paragraphs:
            parsed = conv.parse_ingredient_line(paragraph)
            if parsed:
                ingredients.append(parsed)
                continue
            if conv.is_stop_section(paragraph):
                break

    deduped = []
    seen = set()
    for line in ingredients:
        if not line["ingredient_name"] or line["quantity"] <= 0:
            continue
        key = (conv.normalize_key(line["ingredient_name"]), line["quantity"], line["unit"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(line)
    return deduped


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


def doc_recipe_name(path):
    return conv.clean_recipe_name(path)


def best_doc_match(recipe_name, docs):
    recipe_norm = normalize(recipe_name)
    recipe_tokens = tokens(recipe_name)
    scored = []
    for path in docs:
        doc_name = doc_recipe_name(path)
        doc_norm = normalize(doc_name)
        doc_tokens = tokens(doc_name)
        ratio = SequenceMatcher(None, recipe_norm, doc_norm).ratio()
        overlap = len(recipe_tokens & doc_tokens) / max(1, len(recipe_tokens | doc_tokens))
        containment = 0.15 if (doc_norm and doc_norm in recipe_norm) or (recipe_norm and recipe_norm in doc_norm) else 0
        scored.append((ratio + overlap + containment, ratio, overlap, path))
    scored.sort(reverse=True, key=lambda item: item[0])
    return scored[0]


def ranked_doc_matches(recipe_name, docs):
    recipe_norm = normalize(recipe_name)
    recipe_tokens = tokens(recipe_name)
    scored = []
    for path in docs:
        doc_name = doc_recipe_name(path)
        doc_norm = normalize(doc_name)
        doc_tokens = tokens(doc_name)
        ratio = SequenceMatcher(None, recipe_norm, doc_norm).ratio()
        overlap = len(recipe_tokens & doc_tokens) / max(1, len(recipe_tokens | doc_tokens))
        containment = 0.15 if (doc_norm and doc_norm in recipe_norm) or (recipe_norm and recipe_norm in doc_norm) else 0
        scored.append((ratio + overlap + containment, ratio, overlap, path))
    return sorted(scored, reverse=True, key=lambda item: item[0])


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
        "breadcrumbs": "bread crumb",
        "cornstarch": "corn starch",
        "buttermilk": "butter milk",
    }
    tokens = [replacements.get(token, token) for token in key.split()]
    return " ".join(tokens)


def exact_phrase_in_key(phrase, key):
    phrase_tokens = canonical_food_key(phrase).split()
    key_tokens = canonical_food_key(key).split()
    if not phrase_tokens or not key_tokens:
        return False
    if len(phrase_tokens) == 1:
        return phrase_tokens[0] in key_tokens
    for idx in range(0, len(key_tokens) - len(phrase_tokens) + 1):
        if key_tokens[idx : idx + len(phrase_tokens)] == phrase_tokens:
            return True
    return False


def safer_match_ingredient(line, catalog):
    key = canonical_food_key(line["ingredient_name"])
    code_map = {item["item_code"]: item for item in catalog if item.get("item_code")}
    force_source_only = any(token in key.split() for token in ("kewra", "zest"))
    preferred_codes = sorted(
        conv.PREFERRED_ITEM_CODES,
        key=lambda item: len(canonical_food_key(item[0]).split()),
        reverse=True,
    )
    for phrase, item_code in preferred_codes:
        if force_source_only:
            continue
        if exact_phrase_in_key(phrase, key):
            match = code_map.get(item_code)
            if match:
                return match, "preferred_phrase"

    exact = [item for item in catalog if canonical_food_key(item["ingredient_name"]) == key]
    if len(exact) == 1:
        return exact[0], "exact"

    # Prefer conservative word-level overlap over substring matches, because
    # "chickpeas" must not map to "green peas".
    key_tokens = set(key.split())
    candidates = []
    for item in catalog:
        item_key = canonical_food_key(item["ingredient_name"])
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


def ingredient_key(line):
    return (
        canonical_food_key(line.get("ingredient_name")),
        str(line.get("item_code") or "").strip(),
        str(line.get("unit") or "").strip().lower(),
        round(float(line.get("quantity") or 0), 6),
    )


def missing_item_code(name, existing_count):
    slug = re.sub(r"[^A-Z0-9]+", "", str(name or "").upper())[:8] or "ITEM"
    return f"RCPMIS-CLEAN-{existing_count + 1:03d}-{slug}"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    catalog = conv.load_ingredient_catalog()
    docs = sorted(path for path in SOURCE_DIR.rglob("*.docx") if not path.name.startswith("~$"))
    source_cache = {}
    with INPUT_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        headers = list(conv.RECIPE_HEADERS)

    output_rows = []
    removals = []
    qc_rows = []
    source_audit_rows = []
    missing_rows = {}
    match_counts = Counter()

    for row in rows:
        ranked = ranked_doc_matches(row["name"], docs)
        score, ratio, overlap, source_path = ranked[0]
        for candidate_score, candidate_ratio, candidate_overlap, candidate_path in ranked[:8]:
            if candidate_path not in source_cache:
                paragraphs, tables = conv.docx_text_and_tables(candidate_path)
                source_cache[candidate_path] = {
                    "servings": conv.extract_servings(candidate_path, paragraphs),
                    "ingredients": extract_ingredients_exact(paragraphs, tables),
                }
            if source_cache[candidate_path]["ingredients"]:
                score, ratio, overlap, source_path = candidate_score, candidate_ratio, candidate_overlap, candidate_path
                break
        source = source_cache[source_path]
        source_servings = source["servings"] or float(row.get("servings") or 1) or 1

        rebuilt = []
        for source_index, source_line in enumerate(source["ingredients"], 1):
            match, status = safer_match_ingredient(source_line, catalog)
            clean_line = dict(source_line)
            if match:
                clean_line["ingredient_name"] = match["ingredient_name"]
                clean_line["item_code"] = match["item_code"]
                clean_line["ingredient_id"] = ""
            else:
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
                        "category": row.get("category") or "",
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
            rebuilt.append(clean_line)
            match_counts[status] += 1
            source_audit_rows.append({
                "recipe_name": row["name"],
                "recipe_code": row["recipe_code"],
                "source_file": str(source_path),
                "source_line_no": source_index,
                "source_ingredient_name": source_line.get("ingredient_name", ""),
                "source_quantity": source_line.get("quantity", ""),
                "source_unit": source_line.get("unit", ""),
                "upload_ingredient_name": clean_line.get("ingredient_name", ""),
                "upload_item_code": clean_line.get("item_code", ""),
                "upload_quantity_for_1_serving": "",
                "upload_unit": clean_line.get("unit", ""),
                "match_status": status,
            })

        old_ingredients = json.loads(row.get("ingredients") or "[]")
        source_name_keys = {canonical_food_key(line.get("ingredient_name")) for line in source["ingredients"]}
        rebuilt_name_keys = {canonical_food_key(line.get("ingredient_name")) for line in rebuilt}
        paired = min(len(old_ingredients), len(rebuilt))
        for index, old in enumerate(old_ingredients):
            old_name_key = canonical_food_key(old.get("ingredient_name"))
            source_line = rebuilt[index] if index < paired else None
            if old_name_key not in rebuilt_name_keys and old_name_key not in source_name_keys:
                removals.append({
                    "recipe_name": row["name"],
                    "recipe_code": row["recipe_code"],
                    "source_file": str(source_path),
                    "removed_ingredient_name": old.get("ingredient_name", ""),
                    "removed_item_code": old.get("item_code", ""),
                    "removed_quantity": old.get("quantity", ""),
                    "removed_unit": old.get("unit", ""),
                    "reason": (
                        f"Replaced by source ingredient: {source_line.get('ingredient_name')}"
                        if source_line
                        else "Extra upload ingredient beyond matched source recipe"
                    ),
                })

        scaled = scale_to_one_serving(rebuilt, source_servings)
        for index, scaled_line in enumerate(scaled):
            if len(source_audit_rows) >= len(scaled) - index:
                source_audit_rows[-len(scaled) + index]["upload_quantity_for_1_serving"] = scaled_line.get("quantity", "")
        clean = {header: "" for header in headers}
        clean.update({
            "recipe_code": row.get("recipe_code", ""),
            "name": row.get("name", ""),
            "description": row.get("description", ""),
            "cuisine_type": row.get("cuisine_type", ""),
            "menu_category": row.get("menu_category") or row.get("category", ""),
            "servings": "1",
            "portion_size_grams": row.get("portion_size_grams", ""),
            "batch_yield": row.get("batch_yield") or "1",
            "costing_method": row.get("costing_method") or "average_cost",
            "instructions": row.get("instructions", ""),
            "prep_time_minutes": row.get("prep_time_minutes", ""),
            "cook_time_minutes": row.get("cook_time_minutes", ""),
            "allergens": row.get("allergens", "[]"),
            "site_scope": "specific",
            "site_ids": json.dumps(["KBR-384"]),
            "site_names": json.dumps(["KBR"]),
            "image_url": row.get("image_url", ""),
            "is_active": row.get("is_active", "true"),
        })
        if not scaled:
            output_rows.append(clean)
        else:
            for line_number, line in enumerate(scaled, start=1):
                item_code = line.get("item_code", "")
                output_rows.append({
                    **clean,
                    "line_number": line_number,
                    "ingredient_id": line.get("ingredient_id", ""),
                    "item_code": item_code,
                    "ingredient_code": line.get("ingredient_code", item_code),
                    "sku": line.get("sku", item_code),
                    "ingredient_name": line.get("ingredient_name", ""),
                    "line_quantity": line.get("quantity", ""),
                    "line_unit": line.get("unit", ""),
                    "line_yield_percent": line.get("yield_percent", 100),
                    "line_raw_weight_grams": line.get("raw_weight_grams", ""),
                    "line_yielded_weight_grams": line.get("yielded_weight_grams", ""),
                    "line_cost": line.get("cost", ""),
                })

        qc_rows.append({
            "recipe_name": row["name"],
            "recipe_code": row["recipe_code"],
            "matched_source_file": str(source_path),
            "source_servings": source_servings,
            "old_ingredient_count": len(old_ingredients),
            "clean_ingredient_count": len(rebuilt),
            "removed_count": max(0, len(old_ingredients) - len(rebuilt)),
            "match_score": round(score, 4),
            "name_similarity": round(ratio, 4),
            "token_overlap": round(overlap, 4),
            "needs_review": "YES" if score < 0.65 or not rebuilt else "",
        })

    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(output_rows)

    with REMOVED_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name",
            "recipe_code",
            "source_file",
            "removed_ingredient_name",
            "removed_item_code",
            "removed_quantity",
            "removed_unit",
            "reason",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(removals)

    with QC_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name",
            "recipe_code",
            "matched_source_file",
            "source_servings",
            "old_ingredient_count",
            "clean_ingredient_count",
            "removed_count",
            "match_score",
            "name_similarity",
            "token_overlap",
            "needs_review",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(qc_rows)

    with MISSING_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "item_code",
            "name",
            "ingredient_code",
            "sku",
            "alias",
            "supplier_item_name",
            "unit",
            "category",
            "cuisine_type",
            "cost_per_unit",
            "calories_per_100g",
            "protein_per_100g",
            "carbs_per_100g",
            "fat_per_100g",
            "sodium_per_100g",
            "sugar_per_100g",
            "cooking_yield_percent",
            "shrinkage_percent",
            "raw_weight_per_unit",
            "cooked_weight_per_unit",
            "allergens",
            "is_active",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(missing_rows.values())

    with SOURCE_AUDIT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [
            "recipe_name",
            "recipe_code",
            "source_file",
            "source_line_no",
            "source_ingredient_name",
            "source_quantity",
            "source_unit",
            "upload_ingredient_name",
            "upload_item_code",
            "upload_quantity_for_1_serving",
            "upload_unit",
            "match_status",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(source_audit_rows)

    print(f"rows={len(output_rows)}")
    print(f"removed_report_rows={len(removals)}")
    print(f"match_counts={dict(match_counts)}")
    print(f"output={OUTPUT_CSV}")
    print(f"removed={REMOVED_CSV}")
    print(f"qc={QC_CSV}")
    print(f"missing={MISSING_CSV}")
    print(f"source_audit={SOURCE_AUDIT_CSV}")


if __name__ == "__main__":
    main()
