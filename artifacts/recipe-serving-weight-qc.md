# Recipe Serving Weight Check

Checked against the local 102 General recipes (100-pax source), 28 Philippine recipes, and 349-row ingredient upload. This is a file-based check, not a live database verification.

Weight = raw recipe quantities converted to grams, multiplied by supplied ingredient yields, divided by recipe servings. Liquids use supplied density or the existing 1 g/ml estimate. Bundle weight defaults to 80 g. Saved portion targets are separate from calculated weights. No recipe ingredient quantities or serving counts were changed.

| Cuisine | Recipes | Complete calculation | Missing mapping or weight |
| --- | ---: | ---: | ---: |
| general | 102 | 59 | 43 |
| philippines | 28 | 15 | 13 |

| Recipe code | Recipe | Batch servings | Calculated cooked g/serving | Required data |
| --- | --- | ---: | ---: | --- |
| RCP-001-CLASSICCOF-KBR384 V3 | CLASSIC COFFEE & TANG KBR-384   V3 | 100 | 362 |  |
| RCP-002-CLASSICRUS-KBR384 V3 | Classic Russian Olivier Salad KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for A-TOMEX GREEN PEAS 4/2.5KG (pieces). Weight unavailable for Fresh Dill. |
| RCP-003-FRUITSALAD-KBR384 V3 | FRUIT SALAD KBR-384   V3 | 100 | 181.21 |  |
| RCP-004-MIXMELONPO-KBR384 V3 | MIX MELON PORTION KBR-384   V3 | 100 | 150 |  |
| RCP-005-VIPFRUITSA-KBR384 V3 | VIP FRUIT SALAD KBR-384   V3 | 100 | Unavailable | Weight unavailable for Strawberries. Weight unavailable for whole Pineapples. Weight unavailable for Fresh Blueberries. |
| RCP-006-CHANAMASAL-KBR384 V3 | Chana Masala KBR-384   V3 | 100 | Unavailable | Weight unavailable for Chana masala spice mix. |
| RCP-007-DALCHANAFR-KBR384 V3 | Dal Chana Fry (Breakfast Items 1) KBR-384   V3 | 100 | 341.98 |  |
| RCP-008-DALMASOOR-KBR384 V3 | Dal Masoor (Breakfast Items 1) KBR-384   V3 | 100 | 454.15 |  |
| RCP-009-DALLMONG-KBR384 V3 | Dall Mong KBR-384   V3 | 100 | 286.48 |  |
| RCP-010-FOULMEDAME-KBR384 V3 | Foul Medames KBR-384   V3 | 1 | 110 |  |
| RCP-011-BOILEDEGGS-KBR384 V3 | Boiled Eggs KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-012-CHEESEOMEL-KBR384 V3 | Cheese Omelette.with onion tomato KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for TAFGA SLICED CHEESE 9/800G (pieces). |
| RCP-013-EGGSHAKSHU-KBR384 V3 | Egg Shakshuka KBR-384   V3 | 2 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for Fresh parsley. |
| RCP-014-EGGWITHPOT-KBR384 V3 | Egg with Potato KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-015-FRIEDEGGS2-KBR384 V3 | Fried Eggs.2 pcs KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-016-OMLETTEWIT-KBR384 V3 | Omlette with onion and tomato KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-017-PANOMELETT-KBR384 V3 | Pan omelette KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-018-PLANCHEESE-KBR384 V3 | Plan cheese omlette KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for TAFGA SLICED CHEESE 9/800G (pieces). |
| RCP-019-SCRAMBLEDE-KBR384 V3 | Scrambled Eggs KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-020-VEGETABLEO-KBR384 V3 | Vegetable Omelette KBR-384   V3 | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-021-EGGCURRY-KBR384 V3 | Egg Curry KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-022-FRENCHTOAS-KBR384 V3 | French Toast KBR-384   V3 | 1 | Unavailable | Weight unavailable for SLICED BREAD WHITE (pieces). Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-023-OATMEAL-KBR384 V3 | Oatmeal KBR-384   V3 | 100 | 505.6 |  |
| RCP-024-BUTTERCHIC-KBR384 V3 | Butter Chicken KBR-384   V3 | 100 | 302.89 |  |
| RCP-025-CHICKENBIR-KBR384 V3 | Chicken Biryani KBR-384   V3 | 100 | Unavailable | Weight unavailable for Saffron. |
| RCP-026-CHICKENBRO-KBR384 V3 | Chicken Broasted KBR-384   V3 | 100 | Unavailable | Weight unavailable for ADDOHA FRESH CHICKEN WHOLE IN BAG 1/900G (pieces). |
| RCP-027-CHICKENCHI-KBR384 V3 | Chicken Chilli KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for Chili sauce. |
| RCP-028-CHICKENCUR-KBR384 V3 | Chicken Curry KBR-384   V3 | 100 | Unavailable | Weight unavailable for Whole spices. |
| RCP-029-CHICKENGRI-KBR384 V3 | Chicken Grilled with Lemon Sauce KBR-384   V3 | 100 | Unavailable | Weight unavailable for TANMIAH FRESH CHICKEN 1/900G (pieces). Weight unavailable for Fresh parsley. |
| RCP-030-CHICKENHAL-KBR384 V3 | Chicken Haleem KBR-384   V3 | 100 | 359.24 |  |
| RCP-031-CHICKENHAN-KBR384 V3 | Chicken Handi KBR-384   V3 | 100 | 384.47 |  |
| RCP-032-CHICKENJAL-KBR384 V3 | Chicken Jalfrezi KBR-384   V3 | 100 | 276.71 |  |
| RCP-033-CHICKENKOR-KBR384 V3 | Chicken Korma KBR-384   V3 | 100 | 90 |  |
| RCP-034-CHICKENMAS-KBR384 V3 | Chicken Masala. bone in chicken KBR-384   V3 | 100 | 215.36 |  |
| RCP-035-CHICKENPAL-KBR384 V3 | Chicken Palak KBR-384   V3 | 100 | 227.65 |  |
| RCP-036-CHICKENTAN-KBR384 V3 | Chicken Tandori KBR-384   V3 | 100 | 244.72 |  |
| RCP-037-CHICKENTIK-KBR384 V3 | Chicken Tikka KBR-384   V3 | 100 | Unavailable | Weight unavailable for ADDOHA FRESH CHICKEN WHOLE IN BAG 1/900G (pieces). |
| RCP-038-CRISPYCHIC-KBR384 V3 | Crispy Chicken Strips KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-039-ARABICFOUL-KBR384 V3 | Arabic Foul Medames KBR-384   V3 | 100 | Unavailable | Weight unavailable for Fresh parsley. |
| RCP-040-CHICKPEASM-KBR384 V3 | Chickpeas Masala KBR-384   V3 | 100 | 213.94 |  |
| RCP-041-DAALLOBIA-KBR384 V3 | Daal Lobia KBR-384   V3 | 100 | 210.35 |  |
| RCP-042-DALCHANAFR-KBR384 V3 | Dal Chana Fry (Dall 2) KBR-384   V3 | 100 | 341.98 |  |
| RCP-043-DALMAKHNI-KBR384 V3 | Dal Makhni KBR-384   V3 | 100 | 378 |  |
| RCP-044-DALMASHFRY-KBR384 V3 | Dal Mash Fry KBR-384   V3 | 100 | 339.43 |  |
| RCP-045-DALMASOOR-KBR384 V3 | Dal Masoor (Dall 2) KBR-384   V3 | 100 | 454.15 |  |
| RCP-046-DALLCHANA1-KBR384 V3 | Dall Chana100 pax KBR-384   V3 | 100 | 275.31 |  |
| RCP-047-DALLMAKHNI-KBR384 V3 | Dall Makhni Mix KBR-384   V3 | 100 | 334.01 |  |
| RCP-048-DALLMASH-KBR384 V3 | Dall Mash KBR-384   V3 | 100 | 339.43 |  |
| RCP-049-DALLMONGO-KBR384 V3 | Dall Mongo KBR-384   V3 | 100 | 286.48 |  |
| RCP-050-BAKEDLEMON-KBR384 V3 | Baked Lemon Butter fillet fish KBR-384   V3 | 100 | Unavailable | Weight unavailable for Fresh Parsley. |
| RCP-051-FISHCURRY-KBR384 V3 | Fish Curry KBR-384   V3 | 100 | 306.41 |  |
| RCP-052-FRIEDFINGE-KBR384 V3 | Fried Finger Fish KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-053-GRILLEDFIS-KBR384 V3 | Grilled Fish Fillet KBR-384   V3 | 100 | Unavailable | Weight unavailable for Finely chopped fresh dill or parsley. Weight unavailable for A-TAFGA FRESHLY OREGANO/ZAATAR LEAVES. |
| RCP-054-ALLOGOSHT-KBR384 V3 | Allo Gosht KBR-384   V3 | 100 | 271.99 |  |
| RCP-055-MUTTONBIRY-KBR384 V3 | Mutton Biryani KBR-384   V3 | 100 | 845.14 |  |
| RCP-056-MUTTONCURR-KBR384 V3 | Mutton Curry KBR-384   V3 | 100 | Unavailable | Weight unavailable for Whole Spices. Weight unavailable for Meat masala powder. |
| RCP-057-MUTTONKORM-KBR384 V3 | Mutton Korma KBR-384   V3 | 100 | Unavailable | Weight unavailable for Whole spices. |
| RCP-058-MUTTONKADA-KBR384 V3 | Mutton Kadai KBR-384   V3 | 100 | 222.36 |  |
| RCP-059-PASTAALANO-KBR384 V3 | Pasta ala normah KBR-384   V3 | 100 | 576.8 |  |
| RCP-060-PASTAWITHT-KBR384 V3 | Pasta with Tomato Sauce KBR-384   V3 | 100 | Unavailable | Weight unavailable for A-TAFGA FRESHLY OREGANO/ZAATAR LEAVES. |
| RCP-061-PENNEPASTA-KBR384 V3 | Penne pasta KBR-384   V3 | 100 | 445.6 |  |
| RCP-062-VEGETABLEN-KBR384 V3 | Vegetable Noodles KBR-384   V3 | 100 | Unavailable | Weight unavailable for Chili sauce. |
| RCP-063-ARABICMAND-KBR384 V3 | arabic Mandi Rice KBR-384   V3 | 100 | 618.78 |  |
| RCP-064-BIRYANIRIC-KBR384 V3 | Biryani Rice KBR-384   V3 | 100 | 303 |  |
| RCP-065-BUKHARIRIC-KBR384 V3 | Bukhari Rice KBR-384   V3 | 100 | 551.43 |  |
| RCP-066-CHICKPEARI-KBR384 V3 | Chickpea Rice KBR-384   V3 | 100 | 142.05 |  |
| RCP-067-CHINESEEGG-KBR384 V3 | Chinese Egg Fried Rice KBR-384   V3 | 100 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| RCP-068-CUMINRICE-KBR384 V3 | Cumin Rice KBR-384   V3 | 100 | 80 |  |
| RCP-069-GREENPEASR-KBR384 V3 | Green Peas Rice KBR-384   V3 | 100 | 120 |  |
| RCP-070-PLAINKABSA-KBR384 V3 | Plain Kabsa Rice KBR-384   V3 | 100 | 394.11 |  |
| RCP-071-PLAINPULAO-KBR384 V3 | Plain Pulao Rice KBR-384   V3 | 100 | 80 |  |
| RCP-072-PULAORICE-KBR384 V3 | Pulao Rice KBR-384   V3 | 100 | Unavailable | Weight unavailable for Whole Spices. |
| RCP-073-SAYADIYAHR-KBR384 V3 | Sayadiyah Rice KBR-384   V3 | 100 | 829.33 |  |
| RCP-074-VEGETABLER-KBR384 V3 | Vegetable Rice KBR-384   V3 | 100 | 710.32 |  |
| RCP-075-VERMICELLI-KBR384 V3 | Vermicelli Rice KBR-384   V3 | 100 | 297.67 |  |
| RCP-076-WHITERICE-KBR384 V3 | White Rice KBR-384   V3 | 100 | 305 |  |
| RCP-077-YELLOWRICE-KBR384 V3 | Yellow Rice KBR-384   V3 | 100 | Unavailable | Weight unavailable for Saffron Threads. |
| RCP-078-ZARDARICE-KBR384 V3 | Zarda Rice KBR-384   V3 | 100 | Unavailable | Weight unavailable for Saffron. Weight unavailable for Khoya. |
| RCP-079-CHANACHAT-KBR384 V3 | Chana Chat KBR-384   V3 | 100 | Unavailable | Weight unavailable for Tamarind chutney. Weight unavailable for Fine Sev. Weight unavailable for Papdi. |
| RCP-080-GREENCHUTN-KBR384 V3 | Green Chutney KBR-384   V3 | 100 | 76.69 |  |
| RCP-081-GREENSALAD-KBR384 V3 | Green Salad Mix KBR-384   V3 | 100 | 147.1 |  |
| RCP-082-HUMMUSFOR-KBR384 V3 | Hummus for KBR-384   V3 | 100 | 97.42 |  |
| RCP-083-RAITA-KBR384 V3 | Raita KBR-384   V3 | 100 | 76.86 |  |
| RCP-084-YOGURTCUCU-KBR384 V3 | Yogurt Cucumber Salad KBR-384   V3 | 100 | 152.69 |  |
| RCP-085-LABASHREEN-KBR384 V3 | Lab. a shreen KBR-384   V3 | 100 | Unavailable | Weight unavailable for Khoya. Weight unavailable for Rose syrup. Weight unavailable for Chia seeds / Tukmaria. |
| RCP-086-MAHALABIA-KBR384 V3 | Mahalabia KBR-384   V3 | 100 | 162.5 |  |
| RCP-087-OMALI-KBR384 V3 | omali KBR-384   V3 | 100 | 281.25 |  |
| RCP-088-RICEPUDDIN-KBR384 V3 | Rice pudding KBR-384   V3 | 100 | 225.7 |  |
| RCP-089-SHAHITUKRA-KBR384 V3 | Shahi Tukra KBR-384   V3 | 100 | Unavailable | Weight unavailable for SLICED BREAD WHITE (pieces). Weight unavailable for Saffron. |
| RCP-090-STANDARDCA-KBR384 V3 | Standard Catering Sweet KBR-384   V3 | 100 | Unavailable | Weight unavailable for Flavored Gelatin Powder. Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for Unflavored gelatin powder. |
| RCP-091-VERMICELLI-KBR384 V3 | Vermicelli with Milk KBR-384   V3 | 100 | Unavailable | Weight unavailable for Saffron. |
| RCP-092-ACHARIOKRA-KBR384 V3 | Achari Okra KBR-384   V3 | 100 | Unavailable | Weight unavailable for Achari Masala. |
| RCP-093-ALLOBUJIYA-KBR384 V3 | allo bujiya for KBR-384   V3 | 100 | Unavailable | Weight unavailable for Asafoetida. |
| RCP-094-ALOOGOBI-KBR384 V3 | ALOO GOBI KBR-384   V3 | 100 | 222.98 |  |
| RCP-095-BITTERGOUR-KBR384 V3 | Bitter Gourd POTATO KBR-384   V3 | 100 | 176.49 |  |
| RCP-096-CARROTPOTA-KBR384 V3 | carrot potato green peas mix KBR-384   V3 | 100 | 191.91 |  |
| RCP-097-CAULIFLOWE-KBR384 V3 | Cauliflower Potato Curry KBR-384   V3 | 100 | 312.05 |  |
| RCP-098-DAHIKARIWI-KBR384 V3 | Dahi Kari with Pakora KBR-384   V3 | 100 | Unavailable | Weight unavailable for Curry leaves. |
| RCP-099-GREENBEANS-KBR384 V3 | Green Beans KBR-384   V3 | 100 | 138.1 |  |
| RCP-100-LONEMARROW-KBR384 V3 | LONE MARROW POTATO SWEET PEPPER KBR-384   V3 | 100 | 213.53 |  |
| RCP-101-MIXVEGETAB-KBR384 V3 | Mix Vegetable Curry KBR-384   V3 | 100 | 225.86 |  |
| RCP-102-ROASTPOTAT-KBR384 V3 | Roast Potatoes KBR-384   V3 | 100 | Unavailable | Weight unavailable for Fresh rosemary / thyme. |
| PH-001-BEEFCALDARET | Beef Caldareta Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for Liver Spread. |
| PH-002-BEEFSTEAKPHI | Beef Steak Philippines Filipino KBR-384 1 Serving | 1 | 274.34 |  |
| PH-003-CHLUNCHEONCH | Ch.Luncheon Chicken / Beef Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). Weight unavailable for paprika powder color. |
| PH-004-CHICKENADOBO | Chicken Adobo Philippines Filipino KBR-384 1 Serving | 1 | 331.88 |  |
| PH-005-CHICKENADOBO | Chicken Adobo coconut Philippines Filipino KBR-384 1 Serving | 1 | 415.95 |  |
| PH-006-CHICKENMENUD | Chicken Menudo Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for liver spread. |
| PH-007-CHICKENSOTAN | Chicken Sotanghon Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for celery. |
| PH-008-CHICKENCURRY | Chicken curry Philippines Filipino KBR-384 1 Serving | 1 | 510.39 |  |
| PH-009-CHICKENFRANK | Chicken franks Pilippines Filipino KBR-384 1 Serving | 1 | 150.85 |  |
| PH-010-CHICKENFRYPH | Chicken fry Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for all-purpose seasoning powder. Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| PH-011-CHINESENOODL | Chinese noodle Philippines Filipino KBR-384 1 Serving | 1 | 389.57 |  |
| PH-012-COCONUTVEGET | Coconut vegetable Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for kabocha squash 1 5-inch. Weight unavailable for yardlong beans 2-inch lengths. |
| PH-013-GINATAANGMAN | Ginataang Manok Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for green papaya chayote squash wedges. |
| PH-014-MACKERELTILA | Mackerel / Tilapia / milk fry fish Philippines Filipino KBR-384 1 Serving | 1 | 49.54 |  |
| PH-015-MUNGBEANSOUP | Mung Bean Soup Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for mung beans rinsed drained. |
| PH-016-NILAGASOUPPH | Nilaga soup Philippines Filipino KBR-384 1 Serving | 1 | 709.84 |  |
| PH-017-PAKBETPHILIP | Pak Bet Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for Calabasa (squash). Weight unavailable for String beans (sitaw). Weight unavailable for Bitter melon (ampalaya). |
| PH-018-PANCITMIXPHI | Pancit Mix Philippines Filipino KBR-384 1 Serving | 1 | 411.11 |  |
| PH-019-PESANGSOUPPH | Pesang soup Philippines Filipino KBR-384 1 Serving | 1 | 597.83 |  |
| PH-020-SPAGHETTIPHI | SPAGHETTI PHILIPPINES Filipino KBR-384 1 Serving | 1 | 433.07 |  |
| PH-021-SARDINEPHILI | Sardine Philippines Filipino KBR-384 1 Serving | 1 | 357.24 |  |
| PH-022-SARDINESOTAN | Sardine Sotanghon Philippines Filipino KBR-384 1 Serving | 1 | 348.25 |  |
| PH-023-SCRAMBLEEGGP | Scramble Egg Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for SAEDCO FRESH EGGS MEDIUM 12/30 CT (pieces). |
| PH-024-SINIGANGSOUP | Sinigang soup Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for 50g total Tamarind Soup Mix. Weight unavailable for taro root halved. Weight unavailable for daikon radish. |
| PH-025-SOPASPILIPPI | Sopas Pilippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for celery. |
| PH-026-TINOLASOUPPH | Tinola soup Philippines Filipino KBR-384 1 Serving | 1 | Unavailable | Weight unavailable for Green Papaya or Chayote (Sayote). |
| PH-027-TUNAPHILIPPI | Tuna Philippines Filipino KBR-384 1 Serving | 1 | 365.14 |  |
| PH-028-WHITEHAMOURF | White hamour fry fish Philippines Filipino KBR-384 1 Serving | 1 | 290.92 |  |
