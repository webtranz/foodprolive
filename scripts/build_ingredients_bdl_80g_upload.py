import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(
    r"C:\Users\HP\Documents\ChatGPT\FOOD PRO\artifacts\inventory-ingredients-only\ingredients-yield-calories-allergens.csv"
)
OUTPUT = ROOT / "artifacts" / "inventory-ingredients-only" / "ingredients-yield-calories-allergens-bdl-80g.csv"


def main():
    with SOURCE.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    extra_fields = ["package_base_quantity", "package_base_unit", "package_parse_source"]
    fieldnames = [field for field in fieldnames if field not in extra_fields] + extra_fields

    updated = 0
    for row in rows:
        unit = str(row.get("unit") or "").strip().upper()
        name = str(row.get("ingredient_name") or row.get("name") or "").upper()
        if unit == "BDL" or "(BDL)" in name or " BDL" in name:
            row["package_base_quantity"] = "0.08"
            row["package_base_unit"] = "kg"
            row["package_parse_source"] = "default_bundle_weight"
            updated += 1

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print({
        "rows": len(rows),
        "bdl_rows_updated": updated,
        "output": str(OUTPUT),
    })


if __name__ == "__main__":
    main()
