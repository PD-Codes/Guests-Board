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


# ─── Database ─────────────────────────────────────────────────────

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
      groups       – top-level groups
      group_items  – items within a group (type='device' | 'subgroup')
      item_devices – devices per item (1 for device, n for subgroup)

    Migration: if the old group_devices table exists, transfer to new schema.
                group_items.temp_sensor is added in place when missing.
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}

        conn.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '💡',
                sort INTEGER NOT NULL DEFAULT 0
            )
        """)

        if "group_devices" in tables and "group_items" not in tables:
            # ── Migrate from old schema ───────────────────────────
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
            # ── Fresh install ─────────────────────────────────────
            conn.execute("""
                CREATE TABLE IF NOT EXISTS group_items (
                    id          TEXT PRIMARY KEY,
                    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                    type        TEXT NOT NULL CHECK(type IN ('device','subgroup')),
                    name        TEXT,
                    sort        INTEGER NOT NULL DEFAULT 0,
                    temp_sensor TEXT
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

        # Older databases predate the external temperature sensor override.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(group_items)").fetchall()}
        if "temp_sensor" not in cols:
            conn.execute("ALTER TABLE group_items ADD COLUMN temp_sensor TEXT")

        conn.commit()


# ─── DB helpers ───────────────────────────────────────────────────

def db_load_groups():
    """Load all groups with items (no HA states — entity IDs only)."""
    db = get_db()
    groups = []
    for grow in db.execute(
        "SELECT id, name, icon FROM groups ORDER BY sort, rowid"
    ).fetchall():
        items = []
        for irow in db.execute(
            "SELECT id, type, name, temp_sensor FROM group_items WHERE group_id=? ORDER BY sort, rowid",
            (grow["id"],)
        ).fetchall():
            devs = [r["entity_id"] for r in db.execute(
                "SELECT entity_id FROM item_devices WHERE item_id=? ORDER BY sort, rowid",
                (irow["id"],)
            ).fetchall()]

            if irow["type"] == "device":
                items.append({
                    "id":          irow["id"],
                    "type":        "device",
                    "entity_id":   devs[0] if devs else None,
                    "temp_sensor": irow["temp_sensor"],
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


def entity_id_of(device):
    """
    Accept either a plain entity ID or a full HA state object. /api/groups hands
    subgroup devices back as objects, so a saved config can contain both shapes.
    """
    if isinstance(device, str):
        return device
    if isinstance(device, dict):
        eid = device.get("entity_id")
        return eid if isinstance(eid, str) else None
    return None


def db_save_groups(groups):
    """Atomically replace the full group list."""
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

            # Optional external temperature sensor, only meaningful on devices.
            isensor = item.get("temp_sensor") if itype == "device" else None
            if not (isinstance(isensor, str) and isensor.startswith("sensor.")):
                isensor = None

            db.execute(
                "INSERT INTO group_items (id, group_id, type, name, sort, temp_sensor)"
                " VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,"
                " sort=excluded.sort, temp_sensor=excluded.temp_sensor",
                (iid, gid, itype, iname, item_sort, isensor)
            )

            db.execute("DELETE FROM item_devices WHERE item_id=?", (iid,))

            if itype == "device":
                eid = entity_id_of(item.get("entity_id"))
                if eid:
                    db.execute(
                        "INSERT OR IGNORE INTO item_devices (item_id, entity_id, sort) VALUES (?,?,0)",
                        (iid, eid)
                    )
            else:
                devices = [e for e in (entity_id_of(d) for d in item.get("devices", [])) if e]
                for dev_sort, eid in enumerate(devices):
                    db.execute(
                        "INSERT OR IGNORE INTO item_devices (item_id, entity_id, sort) VALUES (?,?,?)",
                        (iid, eid, dev_sort)
                    )

    db.commit()


# ─── HA helpers ───────────────────────────────────────────────────

def ha_headers():
    return {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type":  "application/json",
    }


def ha_states_map():
    """
    Fetch every HA state in a single request and cache it for the duration of
    the current request. Avoids one HTTP round trip per configured entity.
    """
    if "ha_states" not in g:
        states = {}
        try:
            resp = requests.get(
                f"{HA_URL}/api/states",
                headers=ha_headers(), verify=False, timeout=10,
            )
            if resp.status_code == 200:
                for entity in resp.json():
                    eid = entity.get("entity_id")
                    if eid:
                        states[eid] = entity
        except Exception:
            pass
        g.ha_states = states
    return g.ha_states


def fetch_ha_state(entity_id):
    """Look up one entity in the cached state map."""
    data = ha_states_map().get(entity_id)
    if data is None:
        return {
            "entity_id":     entity_id,
            "state":         "unavailable",
            "attributes":    {},
            "friendly_name": entity_id,
            "domain":        entity_id.split(".")[0],
        }
    attrs = data.get("attributes", {})
    return {
        "entity_id":     entity_id,
        "state":         data.get("state"),
        "attributes":    attrs,
        "friendly_name": attrs.get("friendly_name", entity_id),
        "domain":        entity_id.split(".")[0],
    }


def climate_state(raw_state):
    """Normalize an HVAC mode to the on/off/unavailable vocabulary of the UI."""
    if raw_state in (None, "unavailable", "unknown"):
        return "unavailable"
    return "off" if raw_state == "off" else "on"


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def climate_payload(state, sensor=None):
    """Everything the guest UI needs to render a climate entity."""
    attrs   = state["attributes"]
    current = to_float(attrs.get("current_temperature"))
    source  = None

    if sensor is not None:
        # An external sensor replaces the unit's own reading. When it is
        # unavailable the guest sees no value rather than a misleading one.
        source  = sensor["entity_id"]
        current = to_float(sensor["state"])

    return {
        "hvac_mode":    state["state"],
        "hvac_action":  attrs.get("hvac_action"),
        "hvac_modes":   [m for m in attrs.get("hvac_modes", []) if m != "off"],
        "current_temp": current,
        "temp_source":  source,
        "target_temp":  attrs.get("temperature"),
        "min_temp":     attrs.get("min_temp", 7),
        "max_temp":     attrs.get("max_temp", 35),
        "temp_step":    attrs.get("target_temp_step") or 0.5,
        "fan_mode":     attrs.get("fan_mode"),
        "fan_modes":    attrs.get("fan_modes") or [],
        "swing_mode":   attrs.get("swing_mode"),
        "swing_modes":  attrs.get("swing_modes") or [],
    }


def aggregate_state(device_states):
    """on if at least one device is on, unavailable if all are unavailable."""
    states = [d["state"] for d in device_states]
    if all(s == "unavailable" for s in states):
        return "unavailable"
    return "on" if "on" in states else "off"


def aggregate_attrs(device_states):
    """Average brightness + merged color_modes."""
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
    return jsonify({"error": "Wrong password"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("admin", None)
    return jsonify({"success": True})


@app.route("/api/auth-status")
def auth_status():
    return jsonify({"admin": bool(session.get("admin"))})


# ─── Guest routes ─────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/groups")
def get_groups():
    """Groups with current HA state. Items = device | subgroup."""
    groups = db_load_groups()
    result = []

    for group in groups:
        items_out   = []
        all_eids    = []   # for master switch
        toggleable  = []   # items the master switch and the count badge cover

        for item in group["items"]:
            if item["type"] == "device":
                eid = item.get("entity_id")
                if not eid:
                    continue
                s   = fetch_ha_state(eid)
                out = {
                    "id":            item["id"],
                    "type":          "device",
                    "entity_id":     s["entity_id"],
                    "state":         s["state"],
                    "attributes":    s["attributes"],
                    "friendly_name": s["friendly_name"],
                    "domain":        s["domain"],
                }

                if s["domain"] == "climate":
                    # Climate is standalone: its own controls, never part of the
                    # master switch or the on-count badge.
                    sensor_eid = item.get("temp_sensor")
                    sensor     = fetch_ha_state(sensor_eid) if sensor_eid else None
                    out["state"]       = climate_state(s["state"])
                    out["temp_sensor"] = sensor_eid
                    out["climate"]     = climate_payload(s, sensor)
                else:
                    toggleable.append(out)
                    if s["domain"] == "light":
                        all_eids.append(eid)

                items_out.append(out)

            else:  # subgroup
                dev_states = [fetch_ha_state(e) for e in item.get("devices", [])]
                out = {
                    "id":         item["id"],
                    "type":       "subgroup",
                    "name":       item["name"],
                    "state":      aggregate_state(dev_states),
                    "attributes": aggregate_attrs(dev_states),
                    "devices":    dev_states,
                    "entity_ids": [d["entity_id"] for d in dev_states],
                }
                items_out.append(out)
                toggleable.append(out)
                all_eids.extend(
                    d["entity_id"] for d in dev_states if d["domain"] == "light"
                )

        master_state = aggregate_state(
            [{"state": i["state"]} for i in toggleable]
        ) if toggleable else "off"

        result.append({
            "id":           group["id"],
            "name":         group["name"],
            "icon":         group["icon"],
            "master_state": master_state,
            "all_eids":     list(dict.fromkeys(all_eids)),  # deduplicated, order preserved
            "toggle_total": len(toggleable),
            "on_count":     sum(1 for i in toggleable if i["state"] == "on"),
            "items":        items_out,
        })

    return jsonify({"groups": result})


@app.route("/api/control", methods=["POST"])
def control_device():
    """
    Control one or more devices.
    Body: { entity_id | entity_ids, action, brightness?, rgb_color? }
    """
    data       = request.get_json() or {}
    entity_ids = data.get("entity_ids") or (
        [data["entity_id"]] if data.get("entity_id") else []
    )
    action = data.get("action")

    if not entity_ids or action not in ("turn_on", "turn_off", "toggle"):
        return jsonify({"error": "Invalid parameters"}), 400

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


# Maps a request field to the HA service and its service-data key.
# Order matters: the HVAC mode is applied before anything else, so a device
# that is switched on and adjusted in one go accepts the follow-up calls.
CLIMATE_SERVICES = [
    ("hvac_mode",   "set_hvac_mode",   "hvac_mode"),
    ("temperature", "set_temperature", "temperature"),
    ("fan_mode",    "set_fan_mode",    "fan_mode"),
    ("swing_mode",  "set_swing_mode",  "swing_mode"),
]


@app.route("/api/climate", methods=["POST"])
def control_climate():
    """
    Control a climate entity.
    Body: { entity_id, hvac_mode?, temperature?, fan_mode?, swing_mode? }
    """
    data = request.get_json() or {}
    eid  = data.get("entity_id")

    if not eid or not eid.startswith("climate."):
        return jsonify({"error": "Invalid entity_id"}), 400

    calls = [(svc, key, data[field])
             for field, svc, key in CLIMATE_SERVICES if field in data]
    if not calls:
        return jsonify({"error": "Nothing to set"}), 400

    results = []
    for service, key, value in calls:
        if key == "temperature":
            try:
                value = float(value)
            except (TypeError, ValueError):
                return jsonify({"error": "Invalid temperature"}), 400

        try:
            resp = requests.post(
                f"{HA_URL}/api/services/climate/{service}",
                headers=ha_headers(),
                json={"entity_id": eid, key: value},
                verify=False, timeout=5,
            )
            results.append({"service": service, "ha_status": resp.status_code})
        except Exception as e:
            results.append({"service": service, "error": str(e)})

    return jsonify({"success": all("ha_status" in r for r in results), "results": results})


# ─── Admin routes ─────────────────────────────────────────────────

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

    domain_order = {"light": 0, "switch": 1, "climate": 2}

    filtered = []
    sensors  = []
    for entity in resp.json():
        eid    = entity.get("entity_id", "")
        domain = eid.split(".")[0]

        if domain == "sensor":
            # Offered as an override for a climate unit's built-in reading.
            a = entity.get("attributes", {})
            if a.get("device_class") == "temperature" or \
               a.get("unit_of_measurement") in ("°C", "°F"):
                sensors.append({
                    "entity_id":     eid,
                    "friendly_name": a.get("friendly_name", eid),
                    "state":         entity.get("state"),
                    "unit":          a.get("unit_of_measurement", ""),
                    "domain":        "sensor",
                })
            continue

        if domain not in domain_order:
            continue

        attrs       = entity.get("attributes", {})
        color_modes = attrs.get("supported_color_modes", [])
        row = {
            "entity_id":      eid,
            "friendly_name":  attrs.get("friendly_name", eid),
            "state":          entity.get("state"),
            "domain":         domain,
            "has_brightness": domain == "light",
            "has_color":      any(m in color_modes for m in ("rgb","hs","xy","rgbw","rgbww")),
        }
        if domain == "climate":
            row["hvac_modes"]  = [m for m in attrs.get("hvac_modes", []) if m != "off"]
            row["fan_modes"]   = attrs.get("fan_modes") or []
            row["swing_modes"] = attrs.get("swing_modes") or []
        filtered.append(row)

    filtered.sort(key=lambda x: (domain_order[x["domain"]], x["friendly_name"].lower()))
    sensors.sort(key=lambda x: x["friendly_name"].lower())
    return jsonify({"entities": filtered, "sensors": sensors})


@app.route("/api/admin/config", methods=["GET"])
@admin_required
def get_config():
    return jsonify({"groups": db_load_groups()})


@app.route("/api/admin/config", methods=["POST"])
@admin_required
def save_config_route():
    data = request.get_json() or {}
    if "groups" not in data:
        return jsonify({"error": "Invalid configuration"}), 400
    db_save_groups(data["groups"])
    return jsonify({"success": True})


# ─── Start ────────────────────────────────────────────────────────

init_db()

if __name__ == "__main__":
    print("🏠  Smart Home Guest Server starting...")
    print(f"   HA URL : {HA_URL}")
    print(f"   DB     : {DB_PATH}")
    print(f"   Server : http://0.0.0.0:5000")
    app.run(debug=True, host="0.0.0.0", port=5000, use_reloader=True)
