import csv
import json
import os
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

try:
    from openpyxl import Workbook
except Exception:
    Workbook = None


ROOT = Path("artifacts/recipe-upload-source")
OUT_DIR = Path(os.environ.get("RECIPE_UPLOAD_OUT_DIR", "artifacts/recipe-upload"))
RECIPE_NAME_SUFFIX = os.environ.get("RECIPE_NAME_SUFFIX", "").strip()
RECIPE_CODE_SUFFIX = os.environ.get("RECIPE_CODE_SUFFIX", "").strip()
INGREDIENT_SOURCES = [
    Path("artifacts/inventory-ingredients-only/kbr-384-inventory-upload-corrected.csv"),
    Path("artifacts/inventory-ingredients-only/kbr-384-missing-ingredients-to-add.csv"),
]

RECIPE_HEADERS = [
    "name",
    "recipe_code",
    "description",
    "cuisine_type",
    "category",
    "servings",
    "ingredients",
    "sub_recipes",
    "instructions",
    "prep_time_minutes",
    "cook_time_minutes",
    "allergens",
    "site_scope",
    "site_ids",
    "site_names",
    "image_url",
    "is_active",
]
INGREDIENT_HEADERS = [
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

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
STOP_MARKERS = (
    "instruction",
    "preparation",
    "method",
    "step-by-step",
    "step by step",
    "cooking",
    "nutrition",
    "nutritional",
    "food safety",
    "storage",
    "catering note",
    "catering kitchen note",
)
INGREDIENT_MARKERS = ("ingredient", "ingredients", "serving weights", "portion weights")
SKIP_LINE_PATTERNS = (
    r"^ingredient$",
    r"^quantity",
    r"^notes",
    r"^the ",
    r"^nutrient$",
    r"^total amount",
    r"^yield:",
    r"^prep time",
    r"^cook time",
    r"^final portion",
    r"^total volume",
    r"^serving size",
    r"^these values",
    r"^[\)\]\}]+$",
    r"^finely chopped$",
    r"^chopped$",
    r"^diced$",
    r"^minced$",
    r"^per serving\)?$",
    r"^portion size$",
    r"^total$",
    r"^total finished quantity$",
    r"^total edible weight on the line$",
    r"^individual portions$",
    r"^bone[- ]in\)?$",
    r"^cook ",
    r"^prep ",
    r"^flood ",
    r"^44min ",
    r"^fresh or canned",
    r"^grated$",
    r"^✅",
    r"^\($",
    r"^dispenser prep$",
    r"^simmer ",
    r"^to make ",
    r"^serving\)?$",
    r"^protein$",
    r"^calories?$",
    r"^carbohydrates?$",
    r"^fat$",
    r"^fiber$",
    r"^dietary fiber$",
    r"^sugars?$",
    r"^total sugars?$",
    r"^total fat$",
    r"^saturated fat$",
    r"^cholesterol$",
    r"^vitamin ",
    r"^\)?\s*:?\s*\d+(?:\.\d+)?\s*kcal$",
    r"^\d+(?:\.\d+)?\s*(kg|g|ml|l|pieces?)$",
)

PREFERRED_ITEM_CODES = (
    ("instant coffee", "262233"),
    ("coffee mate", "262241"),
    ("coffeemate", "262241"),
    ("tang powder", "369549"),
    ("tang", "369549"),
    ("water", "224894"),
    ("milk powder", "GR001426"),
    ("full cream milk", "DR000005"),
    ("milk", "DR000005"),
    ("evaporated milk", "153758"),
    ("fresh cream", "342384"),
    ("cream", "342384"),
    ("ghee", "242795"),
    ("unsalted butter", "DR000039"),
    ("butter", "DR000039"),
    ("margarine", "164604"),
    ("yogurt", "DR000284"),
    ("labneh", "DR000284"),
    ("cheese", "171301"),
    ("mozzarella", "DR000390"),
    ("mayonnaise", "275962"),
    ("bread crumb", "272674"),
    ("sliced bread", "BK000001"),
    ("bread", "BK000001"),
    ("oats", "111278"),
    ("all purpose flour", "188559"),
    ("wheat flour", "138855"),
    ("flour", "188559"),
    ("corn flour", "139554"),
    ("corn starch", "139554"),
    ("semolina", "139862"),
    ("vermicelli", "275514"),
    ("macaroni", "262511"),
    ("penne", "386761"),
    ("spaghetti", "386762"),
    ("noodles", "402514"),
    ("basmati rice", "GR003677"),
    ("punjabi rice", "379941"),
    ("white rice", "139868"),
    ("rice", "139868"),
    ("rock salt", "255114"),
    ("fine salt", "166780"),
    ("sea salt", "166780"),
    ("salt", "166780"),
    ("white sugar", "176065"),
    ("granulated sugar", "176065"),
    ("sugar", "176065"),
    ("honey", "132822"),
    ("sunflower oil", "368547"),
    ("olive oil", "185208"),
    ("vegetable oil", "221871"),
    ("cooking oil", "221871"),
    ("oil", "221871"),
    ("tomato paste", "103023"),
    ("tomato puree", "381887"),
    ("crushed tomato", "381887"),
    ("peeled tomato", "381887"),
    ("tomatoes", "PR000005"),
    ("tomato", "PR000005"),
    ("ketchup", "161290"),
    ("orange juice", "379405"),
    ("apple juice", "379401"),
    ("lemon juice", "429366"),
    ("vinegar", "367022"),
    ("soy sauce", "100782"),
    ("oyster sauce", "110196"),
    ("fish sauce", "273104"),
    ("sweet chilli sauce", "199838"),
    ("sweet chili sauce", "199838"),
    ("hot sauce", "133501"),
    ("dry onion", "PR000020"),
    ("fried onion", "PR000020"),
    ("onions", "PR000020"),
    ("onion", "PR000020"),
    ("garlic powder", "401030"),
    ("garlic paste", "PR000018"),
    ("garlic", "PR000018"),
    ("ginger paste", "PR000019"),
    ("ginger garlic", "PR000019"),
    ("ginger-garlic", "PR000019"),
    ("ginger", "PR000019"),
    ("green chilli", "PR000016"),
    ("green chili", "PR000016"),
    ("green pepper", "PR000009"),
    ("red pepper", "PR000105"),
    ("yellow pepper", "PR000106"),
    ("black pepper powder", "185836"),
    ("black pepper", "185836"),
    ("white pepper", "185837"),
    ("red chilli powder", "GR000042"),
    ("red chili powder", "GR000042"),
    ("kashmiri chilli", "GR000042"),
    ("kashmiri chili", "GR000042"),
    ("turmeric", "GR000043"),
    ("coriander powder", "GR000553"),
    ("ground coriander", "GR000553"),
    ("coriander leaves", "PR000062"),
    ("fresh coriander", "PR000062"),
    ("cilantro", "PR000062"),
    ("cumin powder", "GR000583"),
    ("ground cumin", "GR000583"),
    ("cumin whole", "GR000554"),
    ("cumin seeds", "GR000554"),
    ("clove", "GR003482"),
    ("cinnamon", "GR003481"),
    ("black cardamon", "GR002526"),
    ("cardamom", "GR003571"),
    ("cardamon", "GR003571"),
    ("bay leaves", "147040"),
    ("dry lemon", "147047"),
    ("sumac", "190082"),
    ("oregano", "194074"),
    ("basil", "185818"),
    ("mint", "PR000060"),
    ("kasuri methi", "276502"),
    ("fenugreek", "276502"),
    ("paprika", "404682"),
    ("biryani powder", "275700"),
    ("garam masala powder", "GR001943"),
    ("garam masala", "GR001943"),
    ("curry powder", "GR000041"),
    ("korma masala", "GR001943"),
    ("tandoori masala", "GR002636"),
    ("tikka masala", "279340"),
    ("haleem masala", "GR001018"),
    ("chaat masala", "GR003698"),
    ("chaats masala", "GR003698"),
    ("chicken cubes", "102426"),
    ("maggi cubes", "102426"),
    ("potatoes", "PR000022"),
    ("potato", "PR000022"),
    ("carrots", "PR000026"),
    ("carrot", "PR000026"),
    ("cucumber", "PR000010"),
    ("cabbage", "PR000002"),
    ("eggplant", "PR000012"),
    ("marrow", "PR000014"),
    ("bitter gourd", "PR000030"),
    ("cauliflower", "PR000032"),
    ("lettuce", "PR000045"),
    ("okra", "PR000048"),
    ("spinach", "139837"),
    ("green beans", "404331"),
    ("green bean", "404331"),
    ("french beans", "404331"),
    ("mixed vegetable", "404332"),
    ("green peas", "404330"),
    ("peas", "404330"),
    ("sweet corn", "199922"),
    ("broccoli", "139779"),
    ("mushroom", "218618"),
    ("apple", "PR000072"),
    ("banana", "PR000074"),
    ("mango", "PR000076"),
    ("peach", "PR000077"),
    ("kiwi", "PR000078"),
    ("plum", "PR000083"),
    ("watermelon", "PR000084"),
    ("lemon", "PR000090"),
    ("orange", "PR000092"),
    ("mandarin", "PR000093"),
    ("grapes", "139845"),
    ("grape", "139845"),
    ("mixed fruit", "139845"),
    ("melon", "PR000084"),
    ("raisin", "404314"),
    ("almond", "404350"),
    ("cashew", "404349"),
    ("walnut", "404352"),
    ("pistachio", "404353"),
    ("sesame", "404355"),
    ("coconut milk", "185539"),
    ("coconut powder", "404322"),
    ("coconut", "404322"),
    ("chick peas powder", "307316"),
    ("chickpea powder", "307316"),
    ("chickpeas", "GR003046"),
    ("chick peas", "GR003046"),
    ("chana dal", "386163"),
    ("split chick peas", "386163"),
    ("red lentil", "142007"),
    ("brown lentil", "404321"),
    ("urid dal", "139364"),
    ("urad dal", "139364"),
    ("moong dal", "180808"),
    ("mongo", "180808"),
    ("kidney beans", "140068"),
    ("foul medamas", "191262"),
    ("foul medames", "191262"),
    ("tahini", "204980"),
    ("tahina", "204980"),
    ("hummus", "187167"),
    ("hommos", "187167"),
    ("pickle", "267491"),
    ("olive", "191744"),
    ("eggs", "142110"),
    ("egg", "142110"),
    ("chicken breast", "180259"),
    ("boneless chicken", "180259"),
    ("chicken wings", "179446"),
    ("whole chicken", "357255"),
    ("chicken", "205101"),
    ("mutton", "134213"),
    ("beef", "141396"),
    ("hamour", "144669"),
    ("fish fillet", "144669"),
    ("tilapia", "275412"),
    ("tuna", "267650"),
    ("sardine", "153319"),
    ("mackerel", "134884"),
    ("fish", "192264"),
    ("custard", "132875"),
    ("jelly", "145008"),
    ("rose water", "266115"),
    ("vanilla", "132875"),
    ("fava beans", "191262"),
    ("bell pepper", "PR000009"),
    ("capsicum", "PR000009"),
    ("dry pasta", "386761"),
    ("pasta", "386761"),
    ("mustard seeds", "404344"),
    ("mustard seed", "404344"),
    ("dried black lime", "147047"),
    ("black dried limes", "147047"),
    ("black lime", "147047"),
    ("broken wheat", "155583"),
    ("yellow lentil", "386163"),
    ("whole black lentils", "139364"),
    ("black lentils", "139364"),
    ("biryani masala", "275700"),
    ("mandi spice", "285358"),
    ("bukhari spice", "285358"),
    ("sayadiyah spice", "285358"),
    ("red chili flakes", "GR000042"),
    ("red chilli flakes", "GR000042"),
    ("baking powder", "182376"),
    ("besan", "307316"),
    ("fresh herbs", "PR000062"),
    ("fillets", "144669"),
    ("liquid base", "224894"),
    ("daal lobia", "140068"),
    ("toasted nuts", "404350"),
    ("ready made plain croissants or baked puff pastry sheets", "230797"),
    ("plain croissants", "230797"),
    ("puff pastry", "230797"),
)


def normalize_key(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def canonical_ingredient_key(value):
    key = normalize_key(value)
    replacements = {
        "chili": "chilli",
        "tomatoes": "tomato",
        "onions": "onion",
        "potatoes": "potato",
        "carrots": "carrot",
        "chilies": "chilli",
        "chillies": "chilli",
        "cardamom": "cardamon",
        "garbanzo": "chick peas",
        "cilantro": "coriander leaves",
    }
    tokens = [replacements.get(token, token) for token in key.split()]
    key = " ".join(tokens)
    key = re.sub(r"\bpowdered\b", "powder", key)
    key = re.sub(r"\bfresh\b", "", key)
    key = re.sub(r"\bleaves\b", "leaves", key)
    return re.sub(r"\s+", " ", key).strip()


def clean_recipe_name(path):
    name = path.stem
    name = re.sub(r"[_]+", " ", name)
    name = re.sub(r"\s+-\s*copy$", "", name, flags=re.I)
    name = re.sub(r"\s+-\s*$", "", name)
    name = re.sub(r"\bingredients?\b", "", name, flags=re.I)
    name = re.sub(r"\brecipe\b", "", name, flags=re.I)
    name = re.sub(r"\b\d+\s*(pax|servings?|portions?)\b", "", name, flags=re.I)
    name = re.sub(r"\b0?1\s*(pax|servings?|serving)\b", "", name, flags=re.I)
    name = re.sub(r"\bscaled\s+for\b", "", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" .-_")
    return name or path.stem


def is_stop_section(text):
    lowered = text.strip().lower()
    return any(
        lowered.startswith(marker)
        or lowered.startswith(f"🧑‍🍳 {marker}")
        or lowered.startswith(f"👨‍🍳 {marker}")
        or lowered.startswith(f"🔥 {marker}")
        or lowered.startswith(f"⚠️ {marker}")
        or lowered.startswith(f"💡 {marker}")
        for marker in STOP_MARKERS
    )


def recipe_category(path):
    parts = list(path.parts)
    if "ABQAYQ" in parts:
        return "Abqayq Camp"
    if "MENU" in parts:
        indexes = [index for index, part in enumerate(parts) if part == "MENU"]
        if indexes:
            index = indexes[-1]
            if index + 1 < len(parts) - 1:
                return parts[index + 1]
    return path.parent.name


def docx_text_and_tables(path):
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = ET.fromstring(xml)

    paragraphs = []
    for para in root.findall(".//w:p", NS):
        text = "".join(node.text or "" for node in para.findall(".//w:t", NS)).strip()
        if text:
            paragraphs.append(text)

    tables = []
    for table in root.findall(".//w:tbl", NS):
        rows = []
        for row in table.findall(".//w:tr", NS):
            cells = []
            for cell in row.findall("./w:tc", NS):
                cell_text = " ".join(
                    "".join(node.text or "" for node in para.findall(".//w:t", NS)).strip()
                    for para in cell.findall(".//w:p", NS)
                ).strip()
                cells.append(cell_text)
            if any(cells):
                rows.append(cells)
        if rows:
            tables.append(rows)
    return paragraphs, tables


def parse_number(text):
    text = str(text or "").replace(",", "")
    fraction_map = {
        "¼": "1/4",
        "½": "1/2",
        "¾": "3/4",
        "⅓": "1/3",
        "⅔": "2/3",
        "⅛": "1/8",
    }
    for symbol, replacement in fraction_map.items():
        text = text.replace(symbol, replacement)
    range_match = re.search(
        r"(?<!:)\b(?P<start>\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*)(?P<end>\d+(?:\.\d+)?)\b",
        text,
        re.I,
    )
    if range_match:
        return float(range_match.group("end"))
    match = re.search(r"\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?", text)
    if not match:
        return None
    token = match.group(0)
    if "/" in token:
        numerator, denominator = token.split("/", 1)
        try:
            return float(numerator) / float(denominator)
        except ZeroDivisionError:
            return None
    return float(token)


def normalize_unit(quantity, unit):
    unit = str(unit or "").lower().strip(". ")
    conversions = {
        "kilogram": ("kg", 1),
        "kilograms": ("kg", 1),
        "kgs": ("kg", 1),
        "kg": ("kg", 1),
        "gram": ("g", 1),
        "grams": ("g", 1),
        "gm": ("g", 1),
        "gms": ("g", 1),
        "g": ("g", 1),
        "liter": ("l", 1),
        "liters": ("l", 1),
        "litre": ("l", 1),
        "litres": ("l", 1),
        "l": ("l", 1),
        "ml": ("ml", 1),
        "milliliter": ("ml", 1),
        "milliliters": ("ml", 1),
        "cup": ("ml", 240),
        "cups": ("ml", 240),
        "tablespoon": ("ml", 15),
        "tablespoons": ("ml", 15),
        "tbsp": ("ml", 15),
        "teaspoon": ("ml", 5),
        "teaspoons": ("ml", 5),
        "tsp": ("ml", 5),
        "pc": ("pieces", 1),
        "pcs": ("pieces", 1),
        "piece": ("pieces", 1),
        "pieces": ("pieces", 1),
        "egg": ("pieces", 1),
        "eggs": ("pieces", 1),
        "slice": ("pieces", 1),
        "slices": ("pieces", 1),
        "can": ("pieces", 1),
        "cans": ("pieces", 1),
        "bunch": ("pieces", 1),
        "bunches": ("pieces", 1),
        "large": ("pieces", 1),
        "medium": ("pieces", 1),
        "whole": ("pieces", 1),
        "stick": ("pieces", 1),
        "sticks": ("pieces", 1),
        "pint": ("pieces", 1),
        "pints": ("pieces", 1),
        "clove": ("pieces", 1),
        "cloves": ("pieces", 1),
        "unit": ("pieces", 1),
        "units": ("pieces", 1),
    }
    target, multiplier = conversions.get(unit, (unit or "pieces", 1))
    return round(quantity * multiplier, 6), target


def strip_notes(name):
    name = re.sub(r"\([^)]*\)", "", str(name or ""))
    name = name.replace("?", " ")
    name = re.sub(r"[–—]+$", "", name)
    name = re.sub(r"\b(optional|or to taste|to taste|approx\.?|based on|divided)\b.*$", "", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" -:;,.")
    return name


def clean_parsed_ingredient_name(name):
    name = strip_notes(name)
    lowered = name.lower()
    if not name or any(re.search(pattern, lowered) for pattern in SKIP_LINE_PATTERNS):
        return ""
    if re.fullmatch(r"[~\d\s:;.,/\\\-–—]+", name):
        return ""
    return name


QUANTITY_UNIT_PATTERN = (
    r"(?P<qty>\d[\d,]*(?:\.\d+)?(?:\s*(?:-|–|—|to)\s*\d[\d,]*(?:\.\d+)?)?(?:/\d+)?)\s*"
    r"(?P<unit>kg|kgs|g|gm|gms|grams|l|liter|liters|litre|litres|ml|cups?|tablespoons?|tbsp|teaspoons?|tsp|pieces?|pcs?|eggs?|slices?|cans?|bunches?|large|medium|whole|sticks?|pints?|cloves?|units?)\b"
)


def find_quantity_unit(text):
    return re.search(QUANTITY_UNIT_PATTERN, str(text or ""), re.I)


def parse_ingredient_line(line):
    original = str(line or "").strip()
    line = re.sub(r"^[\u25fd\u25fb\u25ab\u2022\-\*]+\s*", "", original).strip()
    line = re.sub(r"\s*\|\s*", ": ", line, count=1)
    line = re.sub(r"\s+[–—]\s+", ": ", line, count=1)
    line = re.sub(r"\s+[?�]\s+(?=~?\d)", ": ", line, count=1)
    line = re.sub(r"\s+", " ", line)
    if not line:
        return None
    lowered = line.lower()
    if any(re.search(pattern, lowered) for pattern in SKIP_LINE_PATTERNS):
        return None

    metric = re.search(r"(?P<qty>\d[\d,]*(?:\.\d+)?)\s*(?P<unit>kg|kgs|g|gm|gms|grams|l|liter|liters|litre|litres|ml)\b", line, re.I)
    if ":" in line:
        left, right = line.split(":", 1)
        if re.search(r"\b(optional|garnish)\b", left, re.I) and ":" in right:
            left, right = right.rsplit(":", 1)
        left_qty_unit = find_quantity_unit(left)
        right_qty_unit = find_quantity_unit(right)
        if left_qty_unit and not right_qty_unit:
            qty = parse_number(left)
            if qty:
                quantity, unit = normalize_unit(qty, left_qty_unit.group("unit"))
                name = clean_parsed_ingredient_name(right)
                return {"ingredient_name": name, "quantity": quantity, "unit": unit} if name else None
        if right_qty_unit:
            qty = parse_number(right_qty_unit.group("qty"))
            quantity, unit = normalize_unit(qty, right_qty_unit.group("unit"))
            name = clean_parsed_ingredient_name(left)
            if not name or re.fullmatch(r"optional|garnish", name, re.I):
                name_text = right[right_qty_unit.end():].strip()
                if not name_text:
                    name_text = right[:right_qty_unit.start()].strip()
                name = clean_parsed_ingredient_name(name_text)
            return {"ingredient_name": name, "quantity": quantity, "unit": unit} if name else None

    leading = re.match(
        r"^(?:optional:\s*)?(?P<qty>\d[\d,]*(?:\.\d+)?(?:/\d+)?)\s*(?P<unit>kg|kgs|g|gm|gms|grams|l|liter|liters|litre|litres|ml|cups?|tablespoons?|tbsp|teaspoons?|tsp|pieces?|pcs?|eggs?|slices?|cans?|bunches?|large|medium|whole|sticks?|pints?|cloves?|units?)\b\s+(?P<name>.+)$",
        line,
        re.I,
    )
    if leading:
        qty = parse_number(leading.group("qty"))
        quantity, unit = normalize_unit(qty, leading.group("unit"))
        name = clean_parsed_ingredient_name(leading.group("name"))
        return {"ingredient_name": name, "quantity": quantity, "unit": unit} if name else None

    if metric:
        qty = parse_number(metric.group("qty"))
        quantity, unit = normalize_unit(qty, metric.group("unit"))
        name = clean_parsed_ingredient_name(line[metric.end():] or line[:metric.start()])
        if name:
            return {"ingredient_name": name, "quantity": quantity, "unit": unit}
    return None


def load_ingredient_catalog():
    catalog = []
    seen = set()
    for source in INGREDIENT_SOURCES:
        if not source.exists():
            continue
        with source.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                item_code = (row.get("item_code") or row.get("sku") or row.get("ingredient_code") or "").strip()
                name = (row.get("ingredient_name") or row.get("name") or row.get("product_name") or "").strip()
                unit = (row.get("unit") or "").strip()
                if not name:
                    continue
                key = (item_code, normalize_key(name))
                if key in seen:
                    continue
                seen.add(key)
                catalog.append({
                    "item_code": item_code,
                    "ingredient_name": name,
                    "unit": unit,
                    "category": (row.get("item_group") or row.get("category") or "").strip(),
                })
    return catalog


def preferred_item_match(key, catalog):
    code_map = {item["item_code"]: item for item in catalog if item.get("item_code")}
    canonical = canonical_ingredient_key(key)
    for phrase, item_code in PREFERRED_ITEM_CODES:
        phrase_key = canonical_ingredient_key(phrase)
        if phrase_key and (phrase_key in canonical or canonical in phrase_key):
            match = code_map.get(item_code)
            if match:
                return match
    return None


def match_ingredient(line, catalog):
    key = canonical_ingredient_key(line["ingredient_name"])
    if not key:
        return None, "blank"
    preferred = preferred_item_match(key, catalog)
    if preferred:
        return preferred, "item_code"

    exact = [item for item in catalog if canonical_ingredient_key(item["ingredient_name"]) == key]
    if len(exact) == 1:
        return exact[0], "exact"

    compact = key.replace(" ", "")
    contains = []
    for item in catalog:
        item_key = canonical_ingredient_key(item["ingredient_name"])
        if not item_key:
            continue
        item_compact = item_key.replace(" ", "")
        if compact and (compact in item_compact or item_compact in compact):
            contains.append(item)
    if len(contains) == 1:
        return contains[0], "contains"
    return None, "unmatched" if not contains else "ambiguous"


def extract_ingredients(paragraphs, tables):
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
        header = [normalize_key(cell) for cell in table[header_index]]
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
            name = row[ingredient_col]
            quantity_text = row[quantity_col]
            parsed = parse_ingredient_line(f"{name}: {quantity_text}")
            if parsed:
                ingredients.append(parsed)
        continue

    for table in tables:
        for row in table:
            if len(row) < 2:
                continue
            joined = " ".join(row).lower()
            if any(marker in joined for marker in ("calories", "protein", "carbohydrates", "cholesterol", "vitamin", "nutrient")):
                continue
            parsed = parse_ingredient_line(f"{row[0]}: {row[1]}")
            if parsed:
                ingredients.append(parsed)

    in_ingredient_section = False
    section_lines = []
    for paragraph in paragraphs:
        lowered = paragraph.lower()
        if any(marker in lowered for marker in INGREDIENT_MARKERS):
            in_ingredient_section = True
            continue
        if in_ingredient_section:
            if is_stop_section(paragraph):
                in_ingredient_section = False
                continue
            parsed = parse_ingredient_line(paragraph)
            if parsed:
                section_lines.append(paragraph)
                ingredients.append(parsed)
                continue

    if not ingredients:
        for paragraph in paragraphs:
            if is_stop_section(paragraph):
                break
            parsed = parse_ingredient_line(paragraph)
            if parsed:
                ingredients.append(parsed)

    deduped = []
    seen = set()
    for line in ingredients:
        if not line["ingredient_name"] or line["quantity"] <= 0:
            continue
        key = (normalize_key(line["ingredient_name"]), line["quantity"], line["unit"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(line)
    return deduped


def extract_servings(path, paragraphs):
    source = "\n".join(paragraphs[:8] + [path.name])
    match = re.search(r"(?:yield|production recipe for)\D{0,30}(\d{1,4})\s*(?:portions?|servings?|pax|persons?)", source, re.I)
    if match:
        return int(match.group(1))
    match = re.search(r"(\d{1,4})\s*(?:portions?|servings?|pax|persons?)", source, re.I)
    if match:
        return int(match.group(1))
    return 100 if re.search(r"\b100\b", path.name) else 1


def extract_instructions(paragraphs):
    started = False
    lines = []
    for paragraph in paragraphs:
        lowered = paragraph.lower()
        if any(marker in lowered for marker in ("instruction", "preparation", "method", "step-by-step", "step by step")):
            started = True
            continue
        if started:
            if any(marker in lowered for marker in ("estimated nutritional", "common allergens", "food safety", "storage notes")):
                break
            lines.append(paragraph)
    return " | ".join(line.strip() for line in lines if line.strip())


def extract_time(paragraphs, label):
    text = " ".join(paragraphs[:10])
    match = re.search(fr"{label}\s*time\s*:\s*(\d+)", text, re.I)
    return int(match.group(1)) if match else ""


def extract_allergens(paragraphs, ingredients):
    text = "\n".join(paragraphs)
    allergens = set()
    marker = re.search(r"common allergens?:([\s\S]+)$", text, re.I)
    if marker:
        for line in marker.group(1).splitlines()[:8]:
            clean = strip_notes(line)
            if clean and len(clean) < 40:
                allergens.add(clean.lower())
    ingredient_text = " ".join(line["ingredient_name"].lower() for line in ingredients)
    checks = {
        "egg": ("egg", "eggs"),
        "milk": ("milk", "dairy", "butter", "yogurt", "mayonnaise", "cream"),
        "wheat": ("wheat", "bread", "pasta", "flour", "gluten"),
        "fish": ("fish",),
        "soy": ("soy",),
    }
    for allergen, needles in checks.items():
        if any(needle in ingredient_text for needle in needles):
            allergens.add(allergen)
    return sorted(allergens)


def build_recipe_code(index, path):
    slug = re.sub(r"[^A-Z0-9]+", "", clean_recipe_name(path).upper())[:10] or "RECIPE"
    suffix = re.sub(r"[^A-Z0-9]+", "", RECIPE_CODE_SUFFIX.upper())
    base = f"RCP-{index:03d}-{slug}"
    return f"{base}-{suffix}" if suffix else base


def missing_item_code(name, existing_count):
    slug = re.sub(r"[^A-Z0-9]+", "", str(name or "").upper())[:8] or "ITEM"
    return f"RCPMIS-{existing_count + 1:03d}-{slug}"


def write_outputs():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    catalog = load_ingredient_catalog()
    docx_files = sorted(path for path in ROOT.rglob("*.docx") if not path.name.startswith("~$"))
    raw_names = [clean_recipe_name(path) for path in docx_files]
    name_counts = Counter(raw_names)
    seen_names = defaultdict(int)
    rows = []
    qc_rows = []
    missing_ingredients = {}

    for index, path in enumerate(docx_files, 1):
        paragraphs, tables = docx_text_and_tables(path)
        raw_name = clean_recipe_name(path)
        seen_names[raw_name] += 1
        name = raw_name
        if name_counts[raw_name] > 1:
            name = f"{raw_name} ({recipe_category(path)} {seen_names[raw_name]})"
        if RECIPE_NAME_SUFFIX:
            name = f"{name} {RECIPE_NAME_SUFFIX}"

        category = recipe_category(path)
        servings = extract_servings(path, paragraphs)
        ingredients = extract_ingredients(paragraphs, tables)
        matched = []
        for ingredient in ingredients:
            match, status = match_ingredient(ingredient, catalog)
            line = dict(ingredient)
            if match:
                line["item_code"] = match["item_code"]
                line["ingredient_id"] = ""
                line["ingredient_name"] = match["ingredient_name"]
                if match["unit"] and line["unit"] not in {"kg", "g", "l", "ml", "pieces"}:
                    line["unit"] = match["unit"]
                status_detail = match["ingredient_name"]
            else:
                missing_key = canonical_ingredient_key(ingredient["ingredient_name"])
                if missing_key not in missing_ingredients:
                    item_code = missing_item_code(ingredient["ingredient_name"], len(missing_ingredients))
                    missing_ingredients[missing_key] = {
                        "item_code": item_code,
                        "name": ingredient["ingredient_name"],
                        "ingredient_code": item_code,
                        "sku": item_code,
                        "alias": "",
                        "supplier_item_name": ingredient["ingredient_name"],
                        "unit": ingredient["unit"] or "kg",
                        "category": category,
                        "cuisine_type": "",
                        "cost_per_unit": 0,
                        "calories_per_100g": "",
                        "protein_per_100g": "",
                        "carbs_per_100g": "",
                        "fat_per_100g": "",
                        "sodium_per_100g": "",
                        "sugar_per_100g": "",
                        "cooking_yield_percent": 100,
                        "shrinkage_percent": 0,
                        "raw_weight_per_unit": "",
                        "cooked_weight_per_unit": "",
                        "allergens": "none",
                        "is_active": "true",
                    }
                line["item_code"] = missing_ingredients[missing_key]["item_code"]
                line["ingredient_id"] = ""
                status_detail = ""
            matched.append(line)
            if status != "exact":
                qc_rows.append({
                    "recipe_name": name,
                    "source_file": str(path),
                    "source_ingredient": ingredient["ingredient_name"],
                    "quantity": ingredient["quantity"],
                    "unit": ingredient["unit"],
                    "match_status": status,
                    "matched_ingredient": status_detail,
                    "action_required": "Confirm ingredient master item_code/id before production costing" if status in {"unmatched", "ambiguous"} else "Review fuzzy name match",
                })

        if not matched:
            qc_rows.append({
                "recipe_name": name,
                "source_file": str(path),
                "source_ingredient": "",
                "quantity": "",
                "unit": "",
                "match_status": "no_ingredients_parsed",
                "matched_ingredient": "",
                "action_required": "Enter recipe ingredient lines manually or revise source document format",
            })

        description = paragraphs[0] if paragraphs else name
        description = re.sub(r"\s+", " ", description).strip()
        rows.append({
            "name": name,
            "recipe_code": build_recipe_code(index, path),
            "description": description[:500],
            "cuisine_type": "",
            "category": category,
            "servings": servings,
            "ingredients": json.dumps(matched, ensure_ascii=False),
            "sub_recipes": "[]",
            "instructions": extract_instructions(paragraphs),
            "prep_time_minutes": extract_time(paragraphs, "prep"),
            "cook_time_minutes": extract_time(paragraphs, "cook"),
            "allergens": json.dumps(extract_allergens(paragraphs, matched), ensure_ascii=False),
            "site_scope": "specific",
            "site_ids": json.dumps(["KBR-384"]),
            "site_names": json.dumps(["KBR"]),
            "image_url": "",
            "is_active": "true",
        })

    recipe_csv = OUT_DIR / "recipes-direct-upload.csv"
    with recipe_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=RECIPE_HEADERS)
        writer.writeheader()
        writer.writerows(rows)

    qc_csv = OUT_DIR / "recipes-direct-upload-qc.csv"
    with qc_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = ["recipe_name", "source_file", "source_ingredient", "quantity", "unit", "match_status", "matched_ingredient", "action_required"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(qc_rows)

    missing_csv = OUT_DIR / "recipes-missing-ingredients-to-add.csv"
    with missing_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=INGREDIENT_HEADERS)
        writer.writeheader()
        writer.writerows(missing_ingredients.values())

    skipped = OUT_DIR / "not-converted-files.txt"
    with skipped.open("w", encoding="utf-8") as handle:
        for path in sorted(ROOT.rglob("*")):
            if path.is_file() and path.suffix.lower() != ".docx":
                handle.write(f"{path}\n")

    if Workbook:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "recipes-direct-upload"
        sheet.append(RECIPE_HEADERS)
        for row in rows:
            sheet.append([row[header] for header in RECIPE_HEADERS])
        qc_sheet = workbook.create_sheet("qc")
        qc_headers = ["recipe_name", "source_file", "source_ingredient", "quantity", "unit", "match_status", "matched_ingredient", "action_required"]
        qc_sheet.append(qc_headers)
        for row in qc_rows:
            qc_sheet.append([row[header] for header in qc_headers])
        missing_sheet = workbook.create_sheet("missing-ingredients")
        missing_sheet.append(INGREDIENT_HEADERS)
        for row in missing_ingredients.values():
            missing_sheet.append([row[header] for header in INGREDIENT_HEADERS])
        workbook.save(OUT_DIR / "recipes-direct-upload-review.xlsx")

    summary = {
        "docx_recipes": len(rows),
        "qc_rows": len(qc_rows),
        "matched_exact_or_contains": sum(
            1 for row in qc_rows if row["match_status"] in {"contains"}
        ),
        "unmatched_or_ambiguous": sum(
            1 for row in qc_rows if row["match_status"] in {"unmatched", "ambiguous", "no_ingredients_parsed"}
        ),
        "missing_ingredients_to_add": len(missing_ingredients),
        "outputs": [str(recipe_csv), str(qc_csv), str(missing_csv), str(skipped)],
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    write_outputs()
