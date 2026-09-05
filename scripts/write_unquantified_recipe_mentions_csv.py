import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIAGNOSTIC_JSON = ROOT / "artifacts" / "recipe-upload-one-go-v5-source-exact" / "unparsed-source-ingredient-lines.json"
OUTPUT_CSV = ROOT / "artifacts" / "recipe-upload-one-go-v5-source-exact" / "source-mentions-without-exact-quantity-v5.csv"


def is_relevant(text):
    lowered = str(text or "").lower()
    return any(term in lowered for term in (
        "to taste", "pinch", "optional", "garnish", "herb", "parsley", "dill",
        "spice", "masala", "saffron", "curry leaves", "salt", "pepper",
        "chili flakes", "chilli flakes",
    ))


def main():
    rows = json.loads(DIAGNOSTIC_JSON.read_text(encoding="utf-8"))
    filtered = [
        {
            "recipe_name": row["recipe_name"],
            "source_file": row["source_file"],
            "source_area": row["source_area"],
            "source_text": row["text"],
            "reason": "No exact numeric quantity in source, so it cannot be costed exactly."
        }
        for row in rows
        if is_relevant(row["text"])
    ]
    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = ["recipe_name", "source_file", "source_area", "source_text", "reason"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(filtered)
    print(json.dumps({"rows": len(filtered), "output": str(OUTPUT_CSV)}, indent=2))


if __name__ == "__main__":
    main()
