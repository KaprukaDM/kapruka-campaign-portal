#!/usr/bin/env python3
"""
Daraz Daily Product Agent
- Uses Daraz's hidden AJAX JSON API (?ajax=true) — no Selenium needed
- Filters: Local sellers, Rs.3000+, Rating 4+, sorted by popularity
- Each keyword scraped across 3 pages
- Ranks by sold count + reviews + rating
- Deduplicates across days
- Analyzes with OpenAI GPT
- Generates HTML report
"""

import os
import re
import json
import time
import random
import hashlib
import logging
import sys
import io
from datetime import datetime, date
from pathlib import Path

import requests
import openai

# ─── CONFIG ───────────────────────────────────────────────────────────────────
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
MIN_PRICE      = 3000
TOP_N          = 20    # overridden by DAILY LIMITS section below
PAGES_PER_CAT  = 3
HISTORY_FILE   = Path(__file__).parent / "seen_products.json"
REPORTS_DIR    = Path(__file__).parent / "reports"
LOG_FILE       = str(Path(__file__).parent / "agent.log")
DELAY_BETWEEN  = 1.0

TEST_MODE      = False   # OFF — full production run

# ─── DAILY LIMITS ────────────────────────────────────────────────────────────
# MAX_URLS_PER_DAY  : how many URLs to scrape each run (out of ~2988 total)
# TOP_N already controls how many products appear in the report
# Rotate through all URLs over many days so nothing is missed
MAX_URLS_PER_DAY  = 50    # scrape 50 URLs per day
TOP_N             = 20    # show top 20 products in report

BASE_URL = (
    "https://www.daraz.lk/catalog/"
    "?location=Local"
    "&page={page}"
    "&price=3000-"
    "&q={q}"
    "&rating=4"
    "&sort=popularity"
    "&ajax=true"
)

# ─── KEYWORDS ─────────────────────────────────────────────────────────────────
KEYWORDS_ELECTRONICS = [
    # Phones & Tablets
    "smartphones", "mobile+phones", "android+phone", "iphone", "tablets",
    "ipad", "samsung+phone", "xiaomi+phone", "realme+phone", "oppo+phone",
    "vivo+phone", "huawei+phone", "phone+under+10000", "budget+smartphone",
    "flagship+phone", "5g+phone", "dual+sim+phone", "refurbished+phone",
    # Laptops & Computers
    "laptops", "notebook+computer", "gaming+laptop", "ultrabook",
    "laptop+under+50000", "acer+laptop", "asus+laptop", "hp+laptop",
    "dell+laptop", "lenovo+laptop", "macbook", "chromebook",
    "desktop+computers", "all+in+one+pc", "mini+pc", "monitors",
    "curved+monitor", "4k+monitor", "gaming+monitor", "computer+ram",
    "ssd+drive", "hard+disk", "graphics+card", "cpu+processor",
    "motherboard", "computer+case", "cpu+cooler", "pc+power+supply",
    # Accessories & Peripherals
    "keyboards+mouse", "mechanical+keyboard", "wireless+keyboard",
    "gaming+mouse", "wireless+mouse", "mouse+pad", "webcam",
    "usb+hub", "usb+accessories", "hdmi+cable", "laptop+stand",
    "laptop+bag", "laptop+sleeve", "screen+protector", "phone+cases",
    "phone+holder", "pop+socket", "phone+stand", "cable+organizer",
    # Networking
    "wifi+router", "networking+devices", "mesh+wifi", "network+switch",
    "ethernet+cable", "wifi+extender", "modem", "powerline+adapter",
    # Power
    "power+bank", "wireless+charger", "phone+charger", "fast+charger",
    "usb+c+charger", "car+charger", "solar+charger", "ups+battery",
    "extension+cord", "surge+protector", "power+strip",
    # Smart Devices
    "smart+home", "smart+devices", "smart+bulb", "smart+plug",
    "smart+speaker", "google+home", "alexa+device", "smart+doorbell",
    "smart+lock", "home+automation", "iot+device",
    # Printers & Office Tech
    "printers", "inkjet+printer", "laser+printer", "printer+ink",
    "printer+cartridge", "scanner", "external+hard+drive",
    "flash+drive", "memory+card", "sd+card",
]

KEYWORDS_AUDIO_VISUAL = [
    # Headphones & Audio
    "headphones", "earphones", "wireless+earbuds", "tws+earbuds",
    "noise+cancelling+headphones", "over+ear+headphones", "in+ear+monitor",
    "gaming+headset", "bluetooth+headphones", "wired+earphones",
    "neckband+earphones", "bone+conduction+headphones",
    "bluetooth+speaker", "portable+speaker", "waterproof+speaker",
    "home+theatre+speaker", "soundbar", "subwoofer", "speakers",
    "studio+monitor", "party+speaker", "mini+speaker",
    # TV & Video
    "television", "smart+tv", "4k+tv", "led+tv", "oled+tv",
    "android+tv", "55+inch+tv", "43+inch+tv", "32+inch+tv",
    "tv+wall+mount", "tv+remote", "set+top+box", "streaming+device",
    "projector", "mini+projector", "home+cinema+projector",
    "projector+screen", "hdmi+projector",
    # Cameras
    "cameras", "dslr+camera", "mirrorless+camera", "action+camera",
    "gopro", "security+camera", "cctv+camera", "ip+camera",
    "dash+cam", "baby+monitor+camera", "trail+camera",
    "camera+lens", "camera+tripod", "camera+bag", "camera+memory+card",
    "ring+light", "led+light+photography",
]

KEYWORDS_GAMING = [
    "gaming", "gaming+accessories", "gaming+keyboard", "gaming+mouse",
    "gaming+headset", "gaming+chair", "gaming+desk", "gaming+monitor",
    "gaming+controller", "ps5+controller", "xbox+controller",
    "joystick", "gaming+mousepad", "rgb+keyboard", "mechanical+gaming+keyboard",
    "gaming+laptop", "gaming+pc", "graphics+card+gaming",
    "gaming+ram", "nvme+ssd", "gaming+router",
    "gaming+microphone", "capture+card", "streaming+setup",
    "console+gaming", "playstation+accessories", "xbox+accessories",
    "nintendo+switch+accessories", "gaming+steering+wheel",
    "vr+headset", "virtual+reality", "gaming+glasses",
]

KEYWORDS_WEARABLES = [
    "smart+watch", "fitness+tracker", "smartband", "activity+tracker",
    "apple+watch+band", "samsung+watch", "amazfit", "garmin+watch",
    "watches", "mens+watches", "womens+watches", "analog+watch",
    "digital+watch", "sports+watch", "luxury+watch", "couple+watch",
    "kids+watch", "watch+strap", "watch+band",
]

KEYWORDS_FASHION = [
    # Mens
    "mens+fashion", "mens+clothing", "mens+t+shirt", "mens+shirt",
    "polo+shirt", "mens+jeans", "cargo+pants", "mens+shorts",
    "mens+formal+shirt", "mens+suit", "blazer", "mens+jacket",
    "mens+hoodie", "mens+sweater", "mens+tracksuit", "mens+underwear",
    "mens+socks", "mens+belt", "mens+wallet", "mens+cap",
    # Womens
    "womens+fashion", "womens+clothing", "womens+tops", "blouse",
    "womens+dress", "maxi+dress", "midi+dress", "mini+dress",
    "womens+jeans", "womens+leggings", "palazzo+pants", "womens+skirt",
    "womens+jacket", "womens+cardigan", "womens+hoodie",
    "womens+undergarments", "womens+nightwear", "womens+swimwear",
    "saree", "kurta", "salwar+kameez", "abaya",
    # Footwear
    "shoes", "sneakers", "running+shoes", "sports+shoes",
    "formal+shoes", "casual+shoes", "loafers", "oxford+shoes",
    "sandals", "slippers", "flip+flops", "boots", "ankle+boots",
    "heels", "wedge+shoes", "womens+flats", "school+shoes",
    # Bags & Accessories
    "bags", "handbags", "shoulder+bag", "tote+bag", "crossbody+bag",
    "backpacks", "school+backpack", "laptop+backpack", "travel+backpack",
    "mens+bag", "waist+bag", "clutch+bag",
    "sunglasses", "reading+glasses", "polarized+sunglasses",
    "fashion+jewelry", "necklace", "bracelet", "earrings", "ring",
    "hair+accessories", "hair+clip", "scrunchie",
    "scarf", "hijab", "hat", "cap", "beanie",
]

KEYWORDS_HOME = [
    # Large Appliances
    "home+appliances", "washing+machine", "front+load+washing+machine",
    "top+load+washing+machine", "refrigerator", "double+door+fridge",
    "single+door+fridge", "air+conditioner", "split+ac", "portable+ac",
    "air+cooler", "water+heater", "dishwasher", "chest+freezer",
    # Small Appliances
    "fan", "ceiling+fan", "table+fan", "stand+fan", "tower+fan",
    "vacuum+cleaner", "robot+vacuum", "handheld+vacuum", "wet+dry+vacuum",
    "iron+garment+care", "steam+iron", "garment+steamer", "clothes+dryer",
    "air+purifier", "humidifier", "dehumidifier",
    "water+purifier", "ro+water+purifier", "water+filter",
    # Furniture
    "furniture", "sofa", "l+shaped+sofa", "sofa+cum+bed",
    "bed+frame", "king+size+bed", "queen+size+bed", "bunk+bed",
    "mattress", "memory+foam+mattress", "spring+mattress", "mattress+topper",
    "wardrobe", "closet+organizer", "chest+of+drawers", "bookshelf",
    "office+chair", "study+table", "dining+table", "dining+chair",
    "coffee+table", "side+table", "tv+stand", "shoe+rack",
    # Bedding & Bath
    "bedding", "bed+sheet", "pillow", "pillows+cushions", "blanket",
    "comforter", "duvet", "quilt", "mosquito+net",
    "bath+towel", "shower+curtain", "bathroom+accessories", "toilet+seat",
    # Decor
    "home+decor", "curtains", "blinds", "wall+art", "photo+frame",
    "vase", "candle+holder", "decorative+lights", "fairy+lights",
    "wall+clock", "mirror", "carpet", "floor+mat", "door+mat",
    # Storage & Organization
    "storage+organizer", "storage+box", "shelf+organizer", "drawer+organizer",
    "clothes+hanger", "laundry+basket", "cleaning+supplies",
    "mop", "broom", "dustpan", "trash+can", "cleaning+brush",
]

KEYWORDS_KITCHEN = [
    # Cooking Appliances
    "kitchen", "rice+cooker", "electric+rice+cooker", "pressure+cooker",
    "blender", "hand+blender", "food+processor", "juicer",
    "microwave+oven", "convection+oven", "toaster+oven", "air+fryer",
    "electric+kettle", "coffee+maker", "espresso+machine", "sandwich+maker",
    "waffle+maker", "electric+grill", "induction+cooker", "hot+plate",
    "slow+cooker", "instant+pot", "steamer",
    # Cookware
    "cookware", "non+stick+pan", "frying+pan", "wok", "sauce+pan",
    "cooking+pot", "pressure+cooker+pot", "baking+tray", "cake+mold",
    "cast+iron+pan", "ceramic+cookware", "cookware+set",
    # Kitchen Tools
    "kitchen+utensils", "knife+set", "cutting+board", "peeler",
    "grater", "colander", "mixing+bowl", "measuring+cup",
    "spatula", "ladle", "tongs", "whisk", "rolling+pin",
    "kitchen+scale", "thermometer", "timer",
    # Dining & Storage
    "dinnerware", "dinner+set", "plates", "bowls", "cups+mugs",
    "water+bottle", "thermos+flask", "lunch+box", "tiffin+box",
    "food+container", "glass+container", "kitchen+storage",
    "spice+rack", "bread+bin", "fruit+basket",
    "kitchen+dining", "dining+set", "table+mat", "coaster",
]

KEYWORDS_TOOLS = [
    "tools+hardware", "power+tools", "hand+tools", "drill+machine",
    "cordless+drill", "hammer+drill", "rotary+tool", "jigsaw",
    "circular+saw", "angle+grinder", "electric+screwdriver",
    "hand+saw", "hammer", "screwdriver+set", "wrench+set",
    "pliers", "measuring+tape", "spirit+level", "tool+box",
    "tool+set", "allen+key+set", "socket+set",
    "electrical+supplies", "wire", "cable", "switch", "socket",
    "circuit+breaker", "multimeter", "voltage+tester",
    "safety+equipment", "safety+helmet", "gloves", "safety+shoes",
    "ladder", "scaffolding", "workbench",
    "paint+brush", "paint+roller", "masking+tape", "sandpaper",
    "wood+glue", "sealant", "putty+knife", "caulking+gun",
    "plumbing+tools", "pipe+wrench", "pipe+cutter",
    "garden+tools", "pruning+shears", "garden+hose", "lawn+mower",
]

KEYWORDS_HEALTH_BEAUTY = [
    # Skincare
    "skincare", "face+wash", "facial+cleanser", "face+scrub",
    "moisturizer", "face+cream", "night+cream", "eye+cream",
    "sunscreen", "spf+50+sunscreen", "face+serum", "vitamin+c+serum",
    "retinol+serum", "hyaluronic+acid", "face+mask", "sheet+mask",
    "clay+mask", "toner", "micellar+water", "makeup+remover",
    "face+oil", "bb+cream", "cc+cream", "face+primer",
    # Makeup
    "makeup", "foundation", "concealer", "powder", "blush",
    "highlighter", "eyeshadow+palette", "eyeliner", "mascara",
    "lipstick", "lip+gloss", "lip+liner", "lip+balm",
    "eyebrow+pencil", "setting+spray", "makeup+brush+set",
    "makeup+sponge", "makeup+kit", "makeup+organizer",
    # Hair Care
    "hair+care", "shampoo", "conditioner", "hair+mask",
    "hair+serum", "hair+oil", "coconut+oil+hair", "argan+oil",
    "hair+color", "hair+dye", "hair+treatment",
    "hair+dryer", "hair+straightener", "curling+iron", "hair+curler",
    "hair+brush", "hair+comb", "detangling+brush",
    # Fragrance & Personal Care
    "perfume", "cologne", "body+spray", "deodorant", "antiperspirant",
    "body+lotion", "body+butter", "body+wash", "shower+gel",
    "soap", "hand+wash", "hand+cream", "foot+cream",
    "personal+care", "electric+toothbrush", "water+flosser",
    "teeth+whitening", "mouthwash", "razor", "shaving+cream",
    "epilator", "hair+removal+cream", "waxing+kit",
    # Health & Wellness
    "health+wellness", "vitamins+supplements", "multivitamin",
    "vitamin+c", "vitamin+d", "omega+3", "fish+oil", "collagen",
    "protein+powder", "whey+protein", "bcaa", "creatine",
    "weight+loss+supplement", "meal+replacement",
    "medical+devices", "blood+pressure+monitor", "glucometer",
    "pulse+oximeter", "thermometer", "weighing+scale",
    "body+fat+scale", "massage+tools", "massage+gun",
    "foam+roller", "acupressure+mat", "heating+pad",
    "first+aid+kit", "bandage", "pain+relief",
    # Feminine & Baby Health
    "feminine+hygiene", "sanitary+pads", "menstrual+cup",
    "pregnancy+test", "breast+pump", "baby+monitor",
]

KEYWORDS_SPORTS = [
    # Fitness Equipment
    "fitness", "exercise+equipment", "home+gym", "gym+equipment",
    "dumbbells", "dumbbell+set", "barbell", "weight+plates",
    "resistance+bands", "pull+up+bar", "push+up+board",
    "ab+roller", "jump+rope", "kettlebell", "battle+rope",
    "yoga+mat", "yoga+block", "yoga+strap", "pilates+equipment",
    "treadmill", "stationary+bike", "exercise+bike", "rowing+machine",
    "elliptical+machine", "stepper", "weight+bench",
    # Sports & Outdoor
    "sports", "cricket+equipment", "cricket+bat", "cricket+ball",
    "cricket+gloves", "cricket+pad", "badminton+racket",
    "shuttlecock", "tennis+racket", "table+tennis", "football",
    "basketball", "volleyball", "rugby+ball", "boxing+gloves",
    "punching+bag", "martial+arts", "swimming", "swimming+goggles",
    "swimming+cap", "snorkeling", "fishing+rod", "fishing+accessories",
    # Cycling & Outdoor
    "cycling", "bicycle+accessories", "bike+helmet", "bike+lock",
    "cycling+gloves", "bike+light", "cycling+shorts",
    "outdoor+sports", "camping", "tent", "sleeping+bag",
    "hiking+backpack", "trekking+poles", "camping+stove",
    "camping+lantern", "water+filter+camping",
    # Sports Apparel
    "sports+shoes", "running+shoes", "training+shoes",
    "sports+wear", "gym+wear", "compression+wear",
    "sports+socks", "sports+gloves", "sports+cap",
    "sports+water+bottle", "protein+shaker",
]

KEYWORDS_BABY_KIDS = [
    "baby", "baby+care", "baby+clothing", "newborn+clothing",
    "baby+romper", "baby+bodysuit", "baby+shoes", "baby+socks",
    "baby+hat", "baby+blanket", "baby+bedding", "baby+cot",
    "baby+carrier", "baby+stroller", "pram", "baby+swing",
    "baby+bouncer", "baby+walker", "baby+high+chair",
    "baby+monitor", "baby+food", "baby+formula", "baby+cereal",
    "baby+bottle", "feeding+bottle", "breast+pump", "bottle+sterilizer",
    "baby+pacifier", "teether", "baby+diaper", "baby+wipes",
    "baby+bath", "baby+shampoo", "baby+lotion", "baby+powder",
    "kids+clothing", "boys+clothing", "girls+clothing",
    "kids+shoes", "school+bag", "kids+backpack",
    "toys", "educational+toys", "building+blocks", "lego",
    "remote+control+car", "remote+control+toys", "rc+drone",
    "doll", "action+figure", "stuffed+animal", "plush+toy",
    "board+games", "puzzle", "card+games", "chess+set",
    "art+supplies", "coloring+book", "clay", "play+dough",
    "school+supplies", "stationery+set", "pencil+case",
    "water+gun", "outdoor+toy", "trampoline", "bicycle+kids",
    "scooter+kids", "roller+skates", "skateboard",
]

KEYWORDS_AUTOMOTIVE = [
    "automotive", "car+accessories", "car+care", "car+wash",
    "car+polish", "car+wax", "car+cleaner", "windshield+cleaner",
    "car+air+freshener", "car+seat+cover", "steering+wheel+cover",
    "car+floor+mat", "car+sunshade", "car+organizer",
    "car+electronics", "car+charger", "car+bluetooth+adapter",
    "car+fm+transmitter", "dash+cam", "rear+view+camera",
    "car+gps", "car+led+lights", "car+interior+lights",
    "tyre+accessories", "tyre+inflator", "car+jack", "jump+starter",
    "car+battery+charger", "car+tool+kit",
    "motorbike+accessories", "motorcycle+helmets", "full+face+helmet",
    "half+face+helmet", "bike+gloves", "riding+jacket",
    "bike+cover", "bike+lock", "motorcycle+chain+oil",
    "bike+mirror", "bike+indicator", "bike+horn",
    "car+perfume", "car+seat+cushion", "car+neck+pillow",
    "parking+sensor", "car+inverter", "car+vacuum",
]

KEYWORDS_PETS = [
    "pet+supplies", "dog+accessories", "cat+accessories",
    "dog+food", "dry+dog+food", "wet+dog+food", "dog+treats",
    "cat+food", "dry+cat+food", "wet+cat+food", "cat+treats",
    "pet+food", "fish+food", "bird+food", "hamster+food",
    "dog+collar", "dog+leash", "dog+harness", "retractable+leash",
    "dog+bed", "dog+crate", "dog+kennel", "dog+carrier",
    "cat+bed", "cat+tree", "cat+scratcher", "cat+litter",
    "cat+litter+box", "cat+carrier", "cat+toys",
    "dog+toys", "chew+toys", "rope+toy", "squeaky+toy",
    "pet+grooming", "dog+shampoo", "cat+shampoo", "pet+brush",
    "nail+clipper+pet", "dog+clothing", "pet+bowl",
    "automatic+pet+feeder", "water+fountain+pet",
    "aquarium", "fish+tank", "aquarium+filter", "aquarium+light",
    "bird+cage", "hamster+cage", "rabbit+hutch",
]

KEYWORDS_GROCERIES = [
    "groceries", "food+beverages", "snacks", "chips", "biscuits",
    "chocolate", "candy", "gummy", "popcorn", "nuts",
    "instant+noodles", "pasta", "rice", "cereals",
    "beverages", "juice", "energy+drink", "coconut+water",
    "green+tea", "black+tea", "tea+coffee", "coffee+powder",
    "instant+coffee", "milk+powder", "protein+milk",
    "cooking+ingredients", "spices", "condiments", "sauces",
    "olive+oil", "coconut+oil", "cooking+oil", "vinegar",
    "honey", "jam", "peanut+butter", "spread",
    "organic+food", "health+food", "gluten+free", "vegan+food",
    "dried+fruits", "seeds", "granola", "muesli",
    "canned+food", "preserved+food", "pickles",
]

KEYWORDS_OFFICE = [
    "office+supplies", "stationery", "pen", "ballpoint+pen",
    "gel+pen", "marker", "highlighter", "pen+pencil",
    "pencil", "mechanical+pencil", "eraser", "sharpener",
    "notebooks", "notebook", "diary", "planner", "sticky+notes",
    "file+folder", "document+holder", "binder", "clipboard",
    "scissors", "stapler", "paper+clip", "rubber+band",
    "tape+dispenser", "correction+tape", "calculator",
    "desk+organizer", "pen+holder", "cable+management",
    "office+furniture", "office+chair", "ergonomic+chair",
    "standing+desk", "monitor+stand", "keyboard+tray",
    "whiteboard", "notice+board", "projector+screen",
    "printer+ink", "toner+cartridge", "a4+paper", "label+printer",
    "laminator", "paper+shredder", "binding+machine",
    "business+card+holder", "name+tag",
]

KEYWORDS_TRAVEL = [
    "luggage", "suitcase", "trolley+bag", "hard+shell+luggage",
    "soft+shell+luggage", "cabin+luggage", "check+in+luggage",
    "travel+bag", "duffel+bag", "weekender+bag", "garment+bag",
    "travel+accessories", "travel+pillow", "eye+mask",
    "luggage+lock", "luggage+tag", "packing+cubes",
    "travel+organizer", "passport+holder", "travel+wallet",
    "travel+adapter", "travel+converter", "portable+charger+travel",
    "travel+toiletry+bag", "travel+size+toiletries",
    "money+belt", "anti+theft+bag", "travel+backpack",
    "beach+bag", "waterproof+bag", "dry+bag",
]

# ─── COMBINE & SHUFFLE for maximum mix ────────────────────────────────────────
import random as _random

_all_keywords = (
    KEYWORDS_ELECTRONICS +
    KEYWORDS_AUDIO_VISUAL +
    KEYWORDS_GAMING +
    KEYWORDS_WEARABLES +
    KEYWORDS_FASHION +
    KEYWORDS_HOME +
    KEYWORDS_KITCHEN +
    KEYWORDS_TOOLS +
    KEYWORDS_HEALTH_BEAUTY +
    KEYWORDS_SPORTS +
    KEYWORDS_BABY_KIDS +
    KEYWORDS_AUTOMOTIVE +
    KEYWORDS_PETS +
    KEYWORDS_GROCERIES +
    KEYWORDS_OFFICE +
    KEYWORDS_TRAVEL
)

# Remove duplicates while preserving order
_seen_kw = set()
KEYWORDS = []
for kw in _all_keywords:
    if kw not in _seen_kw:
        _seen_kw.add(kw)
        KEYWORDS.append(kw)

# Shuffle so every run mixes categories instead of doing all electronics first
_random.seed(42)          # fixed seed = same shuffle every day (consistent)
_random.shuffle(KEYWORDS)

# Build full URL list: each keyword × pages 1,2,3 — shuffled for mix
_all_categories = [
    BASE_URL.format(q=kw, page=pg)
    for kw in KEYWORDS
    for pg in range(1, PAGES_PER_CAT + 1)
]
_random.shuffle(_all_categories)   # shuffle once with fixed seed

# ── Daily rotation ───────────────────────────────────────────────────────────
# Each day picks a DIFFERENT slice of 50 URLs so over many days
# every URL gets covered. Uses today's day-of-year as offset.
_day_offset = date.today().timetuple().tm_yday   # 1–365
_start = (_day_offset * MAX_URLS_PER_DAY) % len(_all_categories)
_end   = _start + MAX_URLS_PER_DAY

if _end <= len(_all_categories):
    CATEGORIES = _all_categories[_start:_end]
else:
    # wrap around end of list
    CATEGORIES = _all_categories[_start:] + _all_categories[:_end - len(_all_categories)]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.1",
    "Referer": "https://www.daraz.lk/",
}

# ─── LOGGING ──────────────────────────────────────────────────────────────────
_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

_console_stream = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
_console_handler = logging.StreamHandler(_console_stream)
_console_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])
log = logging.getLogger(__name__)

# ─── HISTORY (dedup) ──────────────────────────────────────────────────────────
def load_history() -> set:
    if HISTORY_FILE.exists():
        data = json.loads(HISTORY_FILE.read_text())
        return set(data.get("seen", []))
    return set()

def save_history(seen: set):
    HISTORY_FILE.write_text(json.dumps({"seen": list(seen)}, indent=2))

def product_id(product: dict) -> str:
    key = (product.get("title", "") + product.get("url", "")).encode()
    return hashlib.md5(key).hexdigest()

# ─── PARSERS ──────────────────────────────────────────────────────────────────
def coalesce(*args):
    for v in args:
        if v is not None and v != "":
            return v
    return ""

def clean_sold(raw) -> int:
    if raw is None:
        return 0
    s = re.sub(r"<[^>]*>", "", str(raw)).strip()
    if not s:
        return 0
    m = re.search(r"([\d,\.]+)\s*(k?)", s, re.IGNORECASE)
    if not m:
        return 0
    num = float(m.group(1).replace(",", ""))
    if m.group(2).lower() == "k":
        num *= 1000
    return int(num)

def clean_price(raw) -> float:
    if not raw and raw != 0:
        return 0.0
    s = re.sub(r"[^\d.]", "", str(raw))
    try:
        return float(s)
    except ValueError:
        return 0.0

def clean_float(raw) -> float:
    if not raw and raw != 0:
        return 0.0
    try:
        return float(re.sub(r"[^\d.]", "", str(raw)))
    except ValueError:
        return 0.0

def clean_int(raw) -> int:
    if not raw and raw != 0:
        return 0
    try:
        return int(re.sub(r"[^\d]", "", str(raw)))
    except ValueError:
        return 0

def fix_url(href: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://www.daraz.lk" + href
    if not href.startswith("http"):
        return "https://www.daraz.lk/" + href
    return href

# ─── AJAX SCRAPER ─────────────────────────────────────────────────────────────
def fetch_ajax(url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.JSONDecodeError:
            log.warning(f"  Not JSON on attempt {attempt+1}: {url[:80]}")
        except Exception as e:
            log.warning(f"  Attempt {attempt+1} failed: {e}")
        time.sleep(random.uniform(2, 4))
    return None

def parse_items(data: dict) -> list[dict]:
    if not data:
        return []
    mods = data.get("mods") or data.get("mainInfo") or {}
    items = mods.get("listItems") or mods.get("items") or []
    if not isinstance(items, list):
        return []

    products = []
    for x in items:
        try:
            name     = coalesce(x.get("name"), x.get("productTitle"), "")
            price    = clean_price(coalesce(x.get("price"), x.get("priceShow"), 0))
            sold     = clean_sold(coalesce(x.get("itemSoldCntShow"), x.get("soldCnt"), 0))
            reviews  = clean_int(coalesce(x.get("review"), x.get("reviewCount"), 0))
            rating   = clean_float(coalesce(x.get("ratingScore"),
                                   (x.get("rating") or {}).get("average"), 0))
            seller   = coalesce(x.get("sellerName"), x.get("shopName"), "")
            url      = fix_url(coalesce(x.get("productUrl"), x.get("itemUrl"), ""))
            location = str(x.get("location") or "").strip().lower()
            image    = coalesce(x.get("image"), x.get("mainImage"), "")
            if image and image.startswith("//"):
                image = "https:" + image

            if location == "overseas":
                continue
            if not name or price < MIN_PRICE:
                continue

            products.append({
                "title":   name,
                "url":     url,
                "price":   price,
                "sold":    sold,
                "reviews": reviews,
                "rating":  rating,
                "seller":  seller,
                "image":   image,
            })
        except Exception as e:
            log.debug(f"Item parse error: {e}")
            continue
    return products

def scrape_all_categories() -> list[dict]:
    all_products = []
    total = len(CATEGORIES)
    log.info(f"Scraping {total} URLs ({len(KEYWORDS)} keywords x {PAGES_PER_CAT} pages) — shuffled mix...")

    for i, url in enumerate(CATEGORIES, 1):
        q = url.split("q=")[1].split("&")[0] if "q=" in url else url
        pg = url.split("page=")[1].split("&")[0] if "page=" in url else "?"
        log.info(f"  [{i}/{total}] {q} (page {pg})...")
        data = fetch_ajax(url)
        items = parse_items(data)
        all_products.extend(items)
        log.info(f"    +{len(items)} products (running total: {len(all_products)})")
        time.sleep(DELAY_BETWEEN + random.uniform(0, 0.5))

    return all_products

# ─── RANKING ──────────────────────────────────────────────────────────────────
def score_product(p: dict) -> float:
    sold_score   = min((p.get("sold",    0)) / 1000, 1.0)
    review_score = min((p.get("reviews", 0)) / 1000, 1.0)
    rating_score = (p.get("rating", 0)) / 5.0
    return (0.50 * sold_score) + (0.30 * review_score) + (0.20 * rating_score)

def rank_and_filter(products: list[dict], seen: set) -> list[dict]:
    unique = {}
    for p in products:
        pid = product_id(p)
        if pid in seen:
            continue
        key = p["title"].lower()[:60]
        if key not in unique or score_product(p) > score_product(unique[key]):
            unique[key] = p
    ranked = sorted(unique.values(), key=score_product, reverse=True)
    return ranked[:TOP_N]

# ─── OPENAI ANALYSIS ──────────────────────────────────────────────────────────
def analyze_with_openai(products: list[dict]) -> str:
    if not products:
        return "No products to analyze today."
    client = openai.OpenAI(api_key=OPENAI_API_KEY)
    product_summary = "\n".join([
        f"{i+1}. {p['title']} | Rs.{p['price']:,.0f} | {p['rating']} stars | "
        f"{p['sold']:,} sold | {p['reviews']:,} reviews | {p['seller']}"
        for i, p in enumerate(products)
    ])
    prompt = f"""You are a Sri Lankan e-commerce market analyst.
Today is {date.today().strftime('%B %d, %Y')}.

Here are the top 10 trending products on Daraz.lk today
(local sellers only, over Rs.3,000, rated 4 stars+, ranked by sold count and reviews):

{product_summary}

Write a concise daily market insight (3-4 short paragraphs) covering:
1. What categories are dominating today
2. Any notable price trends or value picks
3. A buying recommendation for consumers
4. One sentence outlook for tomorrow

Keep it professional but friendly. Plain text only."""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=600,
            temperature=0.7,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        log.error(f"OpenAI error: {e}")
        return f"AI analysis unavailable today: {e}"

# ─── REPORT GENERATOR ─────────────────────────────────────────────────────────
def generate_html_report(products: list[dict], analysis: str) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    today = date.today().isoformat()
    report_path = REPORTS_DIR / f"daraz_report_{today}.html"

    cards_html = ""
    for i, p in enumerate(products, 1):
        rating_int = int(p.get("rating", 0))
        stars = "★" * rating_int + "☆" * (5 - rating_int)
        score_pct = int(score_product(p) * 100)
        img_tag = (
            f'<img src="{p["image"]}" alt="product" onerror="this.style.display=\'none\'">'
            if p.get("image") else '<div class="no-img">📦</div>'
        )
        cards_html += f"""
        <div class="product-card">
          <div class="rank">#{i}</div>
          <div class="product-img">{img_tag}</div>
          <div class="product-info">
            <a href="{p['url']}" target="_blank" class="product-title">{p['title']}</a>
            <div class="product-meta">
              <span class="price">Rs. {p['price']:,.0f}</span>
              <span class="rating">{stars} {p.get('rating', 0)}</span>
              <span class="sold">🛒 {p.get('sold', 0):,} sold</span>
              <span class="reviews">💬 {p.get('reviews', 0):,} reviews</span>
              <span class="seller">🏪 {p.get('seller', '')}</span>
            </div>
            <div class="score-bar-wrap">
              <div class="score-bar">
                <div class="score-fill" style="width:{score_pct}%"></div>
              </div>
              <span class="score-label">Score: {score_pct}/100</span>
            </div>
            <a href="{p['url']}" target="_blank" class="btn-view">View on Daraz →</a>
          </div>
        </div>"""

    analysis_html = analysis.replace("\n\n", "</p><p>").replace("\n", "<br>")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daraz Daily Report — {today}</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: 'Segoe UI', sans-serif; background: #f4f6fb; color: #222; }}
    header {{ background: linear-gradient(135deg, #f85606, #ff9f00); color: white; padding: 32px 40px; }}
    header h1 {{ font-size: 2rem; letter-spacing: -0.5px; }}
    header p {{ opacity: 0.9; margin-top: 6px; font-size: .95rem; }}
    .badges {{ margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }}
    .badge {{ background: rgba(255,255,255,0.25); border-radius: 20px; padding: 3px 14px; font-size: .82rem; }}
    .container {{ max-width: 940px; margin: 0 auto; padding: 32px 20px; }}
    .section-title {{ font-size: 1.15rem; font-weight: 700; color: #f85606; margin: 28px 0 14px; border-left: 4px solid #f85606; padding-left: 12px; }}
    .analysis-box {{ background: white; border-radius: 12px; padding: 24px 28px; box-shadow: 0 2px 12px rgba(0,0,0,.07); line-height: 1.75; color: #444; }}
    .analysis-box p {{ margin-bottom: 14px; }}
    .product-card {{ background: white; border-radius: 12px; padding: 18px; display: flex; gap: 16px; margin-bottom: 14px; box-shadow: 0 2px 10px rgba(0,0,0,.06); align-items: flex-start; transition: transform .15s; }}
    .product-card:hover {{ transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.1); }}
    .rank {{ font-size: 1.6rem; font-weight: 900; color: #f85606; min-width: 42px; text-align: center; padding-top: 4px; }}
    .product-img img {{ width: 90px; height: 90px; object-fit: contain; border-radius: 8px; border: 1px solid #eee; }}
    .no-img {{ width:90px; height:90px; background:#fef3ea; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:2rem; flex-shrink:0; }}
    .product-info {{ flex: 1; min-width: 0; }}
    .product-title {{ font-size: 1rem; font-weight: 600; color: #222; text-decoration: none; display: block; margin-bottom: 8px; }}
    .product-title:hover {{ color: #f85606; }}
    .product-meta {{ display: flex; flex-wrap: wrap; gap: 8px; font-size: .82rem; color: #666; margin-bottom: 10px; }}
    .price {{ color: #f85606; font-weight: 700; font-size: .95rem; }}
    .rating {{ color: #f5a623; }}
    .score-bar-wrap {{ display: flex; align-items: center; gap: 8px; margin: 8px 0; }}
    .score-bar {{ flex: 1; background: #f0f0f0; border-radius: 20px; height: 8px; overflow: hidden; }}
    .score-fill {{ background: linear-gradient(90deg, #f85606, #ff9f00); height: 100%; border-radius: 20px; }}
    .score-label {{ font-size: .75rem; color: #999; white-space: nowrap; }}
    .btn-view {{ display: inline-block; background: #f85606; color: white; padding: 6px 18px; border-radius: 20px; text-decoration: none; font-size: .82rem; font-weight: 600; margin-top: 6px; }}
    .btn-view:hover {{ background: #d94800; }}
    footer {{ text-align: center; color: #aaa; font-size: .78rem; padding: 32px; border-top: 1px solid #eee; margin-top: 20px; }}
  </style>
</head>
<body>
  <header>
    <h1>Daraz Daily Product Report</h1>
    <p>Top {TOP_N} trending products — local sellers, Rs. 3,000+, rated 4 stars+</p>
    <div class="badges">
      <span class="badge">{datetime.now().strftime('%B %d, %Y  •  %I:%M %p')}</span>
      <span class="badge">{len(products)} products selected</span>
      <span class="badge">{len(KEYWORDS)} keywords x {PAGES_PER_CAT} pages</span>
    </div>
  </header>
  <div class="container">
    <div class="section-title">AI Market Analysis</div>
    <div class="analysis-box"><p>{analysis_html}</p></div>
    <div class="section-title">Today's Top {TOP_N} Products</div>
    {cards_html}
  </div>
  <footer>
    Generated by Daraz Agent &nbsp;•&nbsp; Powered by OpenAI GPT-4o-mini &nbsp;•&nbsp;
    Prices in Sri Lankan Rupees &nbsp;•&nbsp; Local sellers only &nbsp;•&nbsp; Min. 4 star rating
  </footer>
</body>
</html>"""

    report_path.write_text(html, encoding="utf-8")
    log.info(f"Report saved: {report_path}")
    return report_path

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info(f"Daraz Agent starting — {len(KEYWORDS)} keywords x {PAGES_PER_CAT} pages = {len(CATEGORIES)} URLs (shuffled)")
    seen = load_history()
    log.info(f"History: {len(seen)} products already seen")

    raw_products = scrape_all_categories()
    log.info(f"Total scraped: {len(raw_products)} raw products")

    top_products = rank_and_filter(raw_products, seen)
    log.info(f"Top {TOP_N} after dedup + filter: {len(top_products)}")

    if not top_products:
        log.warning("No new qualifying products found today.")
        return None

    log.info("Running OpenAI analysis...")
    analysis = analyze_with_openai(top_products)

    report_path = generate_html_report(top_products, analysis)

    new_seen = seen | {product_id(p) for p in top_products}
    save_history(new_seen)
    log.info(f"History updated: {len(new_seen)} total seen products")
    log.info(f"DONE! Report: {report_path.resolve()}")
    return report_path

if __name__ == "__main__":
    main()