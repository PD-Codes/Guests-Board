import os
import sqlite3
import secrets
import urllib3
import requests
from flask import Flask, render_template, request, jsonify, session, g
from dotenv import load_dotenv
from functools import wraps
from datetime import timedelta

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))
app.permanent_session_lifetime = timedelta(days=7)

HA_URL         = os.getenv("HA_URL", "").rstrip("/")
HA_TOKEN       = os.getenv("HA_TOKEN", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
DB_PATH        = os.path.join(os.path.dirname(__file__), "smarthome.db")


# ─── Datenbank ────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, check_same_thread=False)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop("db", None)
    if db:
        db.close()


def init_db():
    """
    Schema:
      groups       – Hauptgruppen
      group_items  – Items einer Gruppe (type='device' | 'subgroup')
      item_devices – Geräte je Item (1 bei device, n bei subgroup)

    Migration: Falls alte group_devices-Tabelle vorhanden → in neues Schema übertragen.
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}

        # Hauptgruppen-Tabelle (unveränderter Name/Struktur)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '💡',
                sort INTEGER NOT NULL DEFAULT 0
            )
        """)

        if "group_devices" in tables and "group_items" not in tables:
            # ── Migration von alter Struktur ──────────────────────────
            conn.execute("""
                CREATE TABLE group_items (
                    id       TEXT PRIMARY KEY,
                    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                    type     TEXT NOT NULL CHECK(type IN ('device','subgroup')),
                    name     TEXT,
                    sort     INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE item_devices (
                    item_id   TEXT NOT NULL REFERENCES group_items(id) ON DELETE CASCADE,
                    entity_id TEXT NOT NULL,
                    sort      INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (item_id, entity_id)
                )
            """)
            old = conn.execute(
                "SELECT group_id, entity_id, sort FROM group_devices ORDER BY group_id, sort"
            ).fetchall()
            for dev in old:
                iid = "i_" + secrets.token_hex(6)
                conn.execute(
                    "INSERT INTO group_items (id, group_id, type, name, sort) VALUES (?,?,'device',NULL,?)",
                    (iid, dev[0], dev[2])
                )
                conn.execute(
                    "INSERT INTO item_devices (item_id, entity_id, sort) VALUES (?,?,0)",
                    (iid, dev[1])
                )
            conn.execute("DROP TABLE group_devices")
        else:
            # ── Frische Installation ──────────────────────────────────
            conn.execute("""
                CREATE TABLE IF NOT EXISTS group_items (
                    id       TEXT PRIMARY KEY,
                    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                    type     TEXT NOT NULL CHECK(type IN ('device','subgroup')),
                    name     TEXT,
                    sort     INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS item_devices (
                    item_id   TEXT NOT NULL REFERENCES group_items(id) ON DELETE CASCADE,
                    entity_id TEXT NOT NULL,
                    sort      INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (item_id, entity_id)
                )
            """)

        conn.commit()


# ─── DB-Hilfsfunktionen ────────────────────────────────────────────

def db_load_groups():
    """Alle Gruppen mit Items laden (keine HA-Zustände – nur IDs)."""
    db = get_db()
    groups = []
    for grow in db.execute(
        "SELECT id, name, icon FROM groups ORDER BY sort, rowid"
    ).fetchall():
        items = []
        for irow in db.execute(
            "SELECT id, type, name FROM group_items WHERE group_id=? ORDER BY sort, rowid",
            (grow["id"],)
        ).fetchall():
            devs = [r["entity_id"] for r in db.execute(
                "SELECT entity_id FROM item_devices WHERE item_id=? ORDER BY sort, rowid",
                (irow["id"],)
            ).fetchall()]

            if irow["type"] == "device":
                items.append({
                    "id":        irow["id"],
                    "type":      "device",
                    "entity_id": devs[0] if devs else None,
                })
            else:
                items.append({
                    "id":      irow["id"],
                    "type":    "subgroup",
                    "name":    irow["name"],
                    "devices": devs,
                })

        groups.append({
            "id":    grow["id"],
            "name":  grow["name"],
            "icon":  grow["icon"],
            "items": items,
        })
    return groups


def db_save_groups(groups):
    """Komplette Gruppen-Liste atomar ersetzen."""
    db = get_db()

    incoming_gids = {g["id"] for g in groups}
    existing_gids = {r["id"] for r in db.execute("SELECT id FROM groups").fetchall()}

    for gid in existing_gids - incoming_gids:
        db.execute("DELETE FROM groups WHERE id=?", (gid,))

    for sort_idx, group in enumerate(groups):
        gid = group["id"]
        db.execute(
            "INSERT INTO groups (id, name, icon, sort) VALUES (?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, sort=excluded.sort",
            (gid, group["name"], group.get("icon", "💡"), sort_idx)
        )

        incoming_iids  = {item["id"] for item in group.get("items", [])}
        existing_iids  = {r["id"] for r in db.execute(
            "SELECT id FROM group_items WHERE group_id=?", (gid,)
        ).fetchall()}

        for iid in existing_iids - incoming_iids:
            db.execute("DELETE FROM group_items WHERE id=?", (iid,))

        for item_sort, item in enumerate(group.get("items", [])):
            iid   = item["id"]
            itype = item["type"]
            iname = item.get("name") if itype == "subgroup" else None

            db.execute(
                "INSERT INTO group_items (id, group_id, type, name, sort) VALUES (?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, sort=excluded.sort",
                (iid, gid, itype, iname, item_sort)
            )

            db.execute("DELETE FROM item_devices WHERE item_id=?", (iid,))

            if itype == "device":
                eid = item.get("entity_id")
                if eid:
                    db.execute(
                        "INSERT OR IGNORE INTO item_devices (item_id, entity_id, sort) VALUES (?,?,0)",
                        (iid, eid)
                    )
            else:
                for dev_sort, eid in enumerate(item.get("devices", [])):
                    db.execute(
                        "INSERT OR IGNORE INTO item_devices (item_id, entity_id, sort) VALUES (?,?,?)",
                        (iid, eid, dev_sort)
                    )

    db.commit()


# ─── HA-Hilfsfunktionen ────────────────────────────────────────────

def ha_headers():
    return {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type":  "application/json",
    }


def fetch_ha_state(entity_id):
    try:
        resp = requests.get(
            f"{HA_URL}/api/states/{entity_id}",
            headers=ha_headers(), verify=False, timeout=5,
        )
        if resp.status_code == 200:
            data  = resp.json()
            attrs = data.get("attributes", {})
            return {
                "entity_id":    entity_id,
                "state":        data.get("state"),
                "attributes":   attrs,
                "friendly_name": attrs.get("friendly_name", entity_id),
                "domain":       entity_id.split(".")[0],
            }
    except Exception:
        pass
    return {
        "entity_id":    entity_id,
        "state":        "unavailable",
        "attributes":   {},
        "friendly_name": entity_id,
        "domain":       entity_id.split(".")[0],
    }


def aggregate_state(device_states):
    """on wenn mind. ein Gerät an, unavailable wenn alle unavailable."""
    states = [d["state"] for d in device_states]
    if all(s == "unavailable" for s in states):
        return "unavailable"
    return "on" if "on" in states else "off"


def aggregate_attrs(device_states):
    """Durchschnittliche Helligkeit + vereinte color_modes."""
    on_devs = [d for d in device_states if d["state"] == "on"]
    avg_bri = None
    if on_devs:
        bris = [d["attributes"].get("brightness", 255) for d in on_devs]
        avg_bri = round(sum(bris) / len(bris))
    color_modes = list({
        m for d in device_states
        for m in d["attributes"].get("supported_color_modes", [])
    })
    return {"brightness": avg_bri, "supported_color_modes": color_modes}


# ─── Auth ─────────────────────────────────────────────────────────

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    if data.get("password") == ADMIN_PASSWORD:
        session.permanent = True
        session["admin"]  = True
        return jsonify({"success": True})
    return jsonify({"error": "Falsches Passwort"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("admin", None)
    return jsonify({"success": True})


@app.route("/api/auth-status")
def auth_status():
    return jsonify({"admin": bool(session.get("admin"))})


# ─── Gäste-Routen ─────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/groups")
def get_groups():
    """Gruppen mit aktuellem HA-Status. Items = device | subgroup."""
    groups = db_load_groups()
    result = []

    for group in groups:
        items_out   = []
        all_eids    = []   # für Hauptschalter

        for item in group["items"]:
            if item["type"] == "device":
                eid = item.get("entity_id")
                if not eid:
                    continue
                s = fetch_ha_state(eid)
                items_out.append({
                    "id":           item["id"],
                    "type":         "device",
                    "entity_id":    s["entity_id"],
                    "state":        s["state"],
                    "attributes":   s["attributes"],
                    "friendly_name": s["friendly_name"],
                    "domain":       s["domain"],
                })
                if s["domain"] == "light":
                    all_eids.append(eid)

            else:  # subgroup
                dev_states = [fetch_ha_state(e) for e in item.get("devices", [])]
                items_out.append({
                    "id":         item["id"],
                    "type":       "subgroup",
                    "name":       item["name"],
                    "state":      aggregate_state(dev_states),
                    "attributes": aggregate_attrs(dev_states),
                    "devices":    dev_states,
                    "entity_ids": [d["entity_id"] for d in dev_states],
                })
                all_eids.extend(
                    d["entity_id"] for d in dev_states if d["domain"] == "light"
                )

        master_state = aggregate_state([{"state": i["state"]} for i in items_out]) if items_out else "off"

        result.append({
            "id":           group["id"],
            "name":         group["name"],
            "icon":         group["icon"],
            "master_state": master_state,
            "all_eids":     list(dict.fromkeys(all_eids)),  # dedupliziert, Reihenfolge erhalten
            "items":        items_out,
        })

    return jsonify({"groups": result})


@app.route("/api/control", methods=["POST"])
def control_device():
    """
    Steuert ein oder mehrere Geräte.
    Body: { entity_id | entity_ids, action, brightness?, rgb_color? }
    """
    data       = request.get_json() or {}
    entity_ids = data.get("entity_ids") or (
        [data["entity_id"]] if data.get("entity_id") else []
    )
    action = data.get("action")

    if not entity_ids or action not in ("turn_on", "turn_off", "toggle"):
        return jsonify({"error": "Ungültige Parameter"}), 400

    results = []
    for eid in entity_ids:
        domain       = eid.split(".")[0]
        service_data = {"entity_id": eid}

        if action == "turn_on":
            if "brightness" in data:
                service_data["brightness"] = max(0, min(255, int(data["brightness"])))
            if "rgb_color" in data:
                service_data["rgb_color"] = data["rgb_color"]

        try:
            resp = requests.post(
                f"{HA_URL}/api/services/{domain}/{action}",
                headers=ha_headers(), json=service_data, verify=False, timeout=5,
            )
            results.append({"entity_id": eid, "ha_status": resp.status_code})
        except Exception as e:
            results.append({"entity_id": eid, "error": str(e)})

    return jsonify({"success": all("ha_status" in r for r in results), "results": results})


# ─── Admin-Routen ──────────────────────────────────────────────────

@app.route("/api/admin/entities")
@admin_required
def get_entities():
    try:
        resp = requests.get(
            f"{HA_URL}/api/states",
            headers=ha_headers(), verify=False, timeout=10,
        )
        resp.raise_for_status()
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    filtered = []
    for entity in resp.json():
        eid = entity.get("entity_id", "")
        if not (eid.startswith("light.") or eid.startswith("switch.")):
            continue
        attrs       = entity.get("attributes", {})
        color_modes = attrs.get("supported_color_modes", [])
        filtered.append({
            "entity_id":      eid,
            "friendly_name":  attrs.get("friendly_name", eid),
            "state":          entity.get("state"),
            "domain":         eid.split(".")[0],
            "has_brightness": eid.startswith("light."),
            "has_color":      any(m in color_modes for m in ("rgb","hs","xy","rgbw","rgbww")),
        })

    filtered.sort(key=lambda x: (x["domain"] != "light", x["friendly_name"].lower()))
    return jsonify({"entities": filtered})


@app.route("/api/admin/config", methods=["GET"])
@admin_required
def get_config():
    return jsonify({"groups": db_load_groups()})


@app.route("/api/admin/config", methods=["POST"])
@admin_required
def save_config_route():
    data = request.get_json() or {}
    if "groups" not in data:
        return jsonify({"error": "Ungültige Konfiguration"}), 400
    db_save_groups(data["groups"])
    return jsonify({"success": True})


# ─── Start ────────────────────────────────────────────────────────

init_db()

if __name__ == "__main__":
    print("🏠  Smart Home Guest Server startet...")
    print(f"   HA-URL : {HA_URL}")
    print(f"   DB     : {DB_PATH}")
    print(f"   Server : http://0.0.0.0:5000")
    app.run(debug=True, host="0.0.0.0", port=5000, use_reloader=True)
