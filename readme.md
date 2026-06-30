# Home Assistant Guest Board

A lightweight Flask web dashboard that lets guests control your smart home devices (lights & switches) without needing access to Home Assistant itself. Admins configure which devices are visible through a built-in panel.

## Features

- **Guest view** — simple grid of device groups with one-tap on/off and brightness/color controls
- **Admin panel** — password-protected; create groups, add individual devices or subgroups, drag to reorder
- **Subgroups** — bundle multiple entities under one toggle (e.g. all bathroom lights)
- **Live state polling** — device states refresh every 8 seconds automatically
- **Dark, mobile-first UI** — responsive design optimized for phone use on a wall-mounted tablet
- **SQLite persistence** — group configuration stored locally; no extra database server required
- **Home Assistant REST API** — communicates directly with your HA instance using a long-lived access token

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10+, Flask 3 |
| Database | SQLite (via `sqlite3`) |
| Frontend | Vanilla JS, CSS (no framework) |
| HA Integration | Home Assistant REST API |

## Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd HomeAssistantGuestBoard
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux / macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `HA_URL` | Full URL of your Home Assistant instance (e.g. `https://homeassistant.local:8123`) |
| `HA_TOKEN` | Long-lived access token — create one in HA under **Profile → Security → Long-Lived Access Tokens** |
| `ADMIN_PASSWORD` | Password to access the admin panel |
| `SECRET_KEY` | Random secret for Flask session signing — use a long random string |

### 3. Run

```bash
python app.py
```

The server starts on `http://0.0.0.0:5000`. Open it in a browser and tap the lock icon to log in as admin and configure your device groups.

## Project Structure

```
HomeAssistantGuestBoard/
├── app.py              # Flask application, API routes, DB logic
├── requirements.txt    # Python dependencies
├── .env.example        # Environment variable template
├── smarthome.db        # SQLite database (auto-created on first run)
├── templates/
│   └── index.html      # Single-page HTML shell
└── static/
    ├── app.js          # All frontend logic (vanilla JS)
    └── index.css       # Styles
```

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | — | Serves the guest UI |
| GET | `/api/groups` | — | Returns all groups with current HA states |
| POST | `/api/control` | — | Toggle / turn on / turn off one or more entities |
| POST | `/api/login` | — | Admin login |
| POST | `/api/logout` | — | Admin logout |
| GET | `/api/auth-status` | — | Check if current session is admin |
| GET | `/api/admin/entities` | Admin | List all lights & switches from HA |
| GET | `/api/admin/config` | Admin | Load current group configuration |
| POST | `/api/admin/config` | Admin | Save group configuration |

## Notes

- SSL verification is disabled (`verify=False`) to support Home Assistant instances with self-signed certificates. If your HA uses a valid certificate, you can remove the `verify=False` calls in `app.py`.
- The database is created automatically at startup. No migration step needed for fresh installs.
- For production use, run behind a reverse proxy (nginx, Caddy) with HTTPS instead of using Flask's built-in development server.
