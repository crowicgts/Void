const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const GTPS_PORT = process.env.GTPS_PORT || 25741;
const GTPS_CLOUD_API = `https://api.gtps.cloud/g-api/${GTPS_PORT}/status`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database File Persistence
const DB_FILE = path.join(__dirname, 'users.json');

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('Error reading database:', e);
    }
    return { users: [] };
}

function saveDatabase(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving database:', e);
    }
}

let db = loadDatabase();
const sessions = {}; // token -> userId

function hashPassword(pwd) {
    return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

function generateUniqueCode() {
    let code;
    let exists = true;
    while (exists) {
        code = Math.floor(100000 + Math.random() * 900000).toString();
        exists = db.users.some(u => u.uniqueCode === code);
    }
    return code;
}

let serverData = {
    status: "ONLINE",
    lastHeartbeat: Date.now(),
    port: GTPS_PORT,
    playerCount: 1,
    players: [],
    logs: []
};

// Inbound push from GTPS Lua
app.post('/api/sync', (req, res) => {
    const data = req.body || {};
    serverData = {
        status: "ONLINE",
        lastHeartbeat: Date.now(),
        port: data.port || GTPS_PORT,
        playerCount: data.playerCount || (data.players ? data.players.length : 0),
        players: data.players || [],
        logs: data.logs || serverData.logs || []
    };
    return res.json({ success: true });
});

// Periodic polling from GTPS Cloud Gateway
async function pollGTPSCloud() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const response = await fetch(GTPS_CLOUD_API, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
            serverData.status = "ONLINE";
            serverData.lastHeartbeat = Date.now();

            const text = await response.text();
            if (text && text.trim().startsWith('{')) {
                try {
                    const data = JSON.parse(text);
                    serverData.port = data.port || GTPS_PORT;
                    serverData.playerCount = data.playerCount || (data.players ? data.players.length : serverData.playerCount);
                    serverData.players = data.players || serverData.players;
                    serverData.logs = data.logs || serverData.logs;
                } catch (e) {}
            }
        } else {
            if (Date.now() - serverData.lastHeartbeat > 15000) {
                serverData.status = "OFFLINE";
            }
        }
    } catch (err) {
        if (Date.now() - serverData.lastHeartbeat > 15000) {
            serverData.status = "OFFLINE";
        }
    }
}

setInterval(pollGTPSCloud, 2500);
pollGTPSCloud();

app.get('/api/status', (req, res) => {
    res.json(serverData);
});

// Authentication Middleware
function getAuthUser(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token || !sessions[token]) return null;
    const userId = sessions[token];
    return db.users.find(u => u.id === userId) || null;
}

// User Registration
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || typeof username !== 'string' || username.trim().length < 4) {
        return res.status(400).json({ success: false, error: 'Username must be at least 4 characters.' });
    }

    const cleanUsername = username.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanUsername)) {
        return res.status(400).json({ success: false, error: 'Username contains invalid characters. Use letters, numbers, _ or -.' });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    const existing = db.users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (existing) {
        return res.status(400).json({ success: false, error: 'Username is already registered.' });
    }

    const newUser = {
        id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        username: cleanUsername,
        passwordHash: hashPassword(password),
        uniqueCode: generateUniqueCode(),
        linkedGrowId: null,
        createdAt: Date.now()
    };

    db.users.push(newUser);
    saveDatabase(db);

    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = newUser.id;

    return res.json({
        success: true,
        token: token,
        user: {
            username: newUser.username,
            uniqueCode: newUser.uniqueCode,
            linkedGrowId: newUser.linkedGrowId,
            createdAt: newUser.createdAt
        }
    });
});

// User Login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Please provide username and password.' });
    }

    const cleanUsername = String(username).trim();
    const user = db.users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());

    if (!user || user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = user.id;

    return res.json({
        success: true,
        token: token,
        user: {
            username: user.username,
            uniqueCode: user.uniqueCode,
            linkedGrowId: user.linkedGrowId,
            createdAt: user.createdAt
        }
    });
});

// Current User Profile & Live Stats
app.get('/api/auth/me', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let liveStats = null;
    if (user.linkedGrowId && serverData.players && Array.isArray(serverData.players)) {
        const p = serverData.players.find(x => (x.name || '').toLowerCase() === user.linkedGrowId.toLowerCase());
        if (p) {
            liveStats = {
                isOnline: true,
                world: p.world || 'EXIT',
                gems: p.gems || 0,
                level: p.level || 1,
                wl: p.wl || 0
            };
        } else {
            liveStats = {
                isOnline: false
            };
        }
    }

    return res.json({
        success: true,
        user: {
            username: user.username,
            uniqueCode: user.uniqueCode,
            linkedGrowId: user.linkedGrowId,
            createdAt: user.createdAt,
            liveStats: liveStats
        }
    });
});

// User Logout
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token && sessions[token]) {
        delete sessions[token];
    }
    return res.json({ success: true });
});

// Unlink Account
app.post('/api/auth/unlink', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    user.linkedGrowId = null;
    saveDatabase(db);

    return res.json({ success: true, message: 'Account unlinked successfully.' });
});

// In-Game /accept Verification Endpoint (Called by GTPS Lua)
app.post('/api/link-verify', (req, res) => {
    const { growId, code } = req.body || {};

    if (!growId || !code) {
        return res.status(400).json({ success: false, message: 'Missing GrowID or link code.' });
    }

    const cleanGrowId = String(growId).trim();
    const cleanCode = String(code).trim();

    const user = db.users.find(u => u.uniqueCode === cleanCode);

    if (!user) {
        return res.status(404).json({ success: false, message: 'Invalid or expired unique link code.' });
    }

    user.linkedGrowId = cleanGrowId;
    saveDatabase(db);

    console.log(`[Account Linked] GrowID "${cleanGrowId}" successfully linked to Website User "${user.username}" (Code: ${cleanCode})`);

    return res.json({
        success: true,
        username: user.username,
        growId: user.linkedGrowId,
        message: 'Account linked successfully!'
    });
});

app.get('/logo.png', (req, res) => {
    const localPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(localPath)) {
        return res.sendFile(localPath);
    }
    res.redirect('https://i.ibb.co/6PzX2G1/void-logo.png');
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VOID Private Server • Official Portal</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-black: #080706;
            --bg-card: rgba(22, 18, 12, 0.92);
            --bg-card-hover: rgba(36, 30, 18, 0.96);
            --gold-primary: #d4af37;
            --gold-bright: #fbbf24;
            --gold-light: #fef08a;
            --gold-glow: rgba(212, 175, 55, 0.45);
            --gold-border: rgba(212, 175, 55, 0.4);
            --text-main: #ffffff;
            --text-muted: #d1c7b7;
            --online-green: #10b981;
            --offline-red: #ef4444;
            --discord-color: #5865f2;
            --whatsapp-color: #25d366;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

        body {
            background-color: var(--bg-black);
            color: var(--text-main);
            min-height: 100vh;
            overflow-x: hidden;
            position: relative;
            background-image: 
                radial-gradient(circle at 15% 15%, rgba(212, 175, 55, 0.15) 0%, transparent 45%),
                radial-gradient(circle at 85% 15%, rgba(251, 191, 36, 0.12) 0%, transparent 45%),
                radial-gradient(circle at 50% 85%, rgba(180, 130, 20, 0.2) 0%, transparent 55%);
        }

        #gold-canvas {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            pointer-events: none;
            z-index: 0;
        }

        /* Navbar */
        .navbar {
            position: relative;
            z-index: 10;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 44px;
            height: 76px;
            background: rgba(12, 10, 8, 0.95);
            border-bottom: 2px solid var(--gold-border);
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.95), 0 0 25px rgba(212, 175, 55, 0.2);
        }

        .nav-socials {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .social-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 42px;
            height: 42px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--gold-border);
            color: #ffffff;
            text-decoration: none;
            transition: all 0.25s ease;
        }

        .social-btn:hover {
            transform: translateY(-2px);
            border-color: var(--gold-bright);
            box-shadow: 0 0 18px var(--gold-glow);
        }

        .social-btn.discord:hover { background: var(--discord-color); border-color: var(--discord-color); }
        .social-btn.whatsapp:hover { background: var(--whatsapp-color); border-color: var(--whatsapp-color); }

        .social-btn svg { width: 22px; height: 22px; fill: currentColor; }

        .nav-controls {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .auth-status-btn {
            background: rgba(212, 175, 55, 0.2);
            border: 1px solid var(--gold-border);
            color: var(--gold-bright);
            padding: 9px 18px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        }

        .auth-status-btn:hover {
            background: var(--gold-primary);
            color: #000;
            box-shadow: 0 0 20px var(--gold-glow);
        }

        .audio-toggle-btn {
            background: rgba(212, 175, 55, 0.15);
            border: 1px solid var(--gold-border);
            color: #fff;
            padding: 9px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        }

        .audio-toggle-btn:hover {
            background: rgba(212, 175, 55, 0.35);
            box-shadow: 0 0 15px var(--gold-glow);
        }

        .lang-switch-btn {
            background: rgba(212, 175, 55, 0.15);
            border: 1px solid var(--gold-border);
            color: #fff;
            padding: 9px 18px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 10px;
            transition: all 0.25s ease;
        }

        .lang-switch-btn:hover {
            background: rgba(212, 175, 55, 0.35);
            box-shadow: 0 0 20px var(--gold-glow);
            transform: translateY(-2px);
        }

        .flag-img { width: 22px; height: 15px; border-radius: 2px; object-fit: cover; }

        /* Hero */
        .hero {
            position: relative;
            z-index: 1;
            padding: 60px 20px 30px 20px;
            text-align: center;
            max-width: 900px;
            margin: 0 auto;
        }

        .main-logo-img {
            max-width: 460px;
            width: 85%;
            height: auto;
            margin-bottom: 24px;
            filter: drop-shadow(0 0 35px rgba(212, 175, 55, 0.7));
            animation: floatLogo 3.5s ease-in-out infinite alternate;
        }

        @keyframes floatLogo {
            0% { transform: translateY(0); filter: drop-shadow(0 0 30px rgba(212, 175, 55, 0.5)); }
            100% { transform: translateY(-8px); filter: drop-shadow(0 0 55px rgba(251, 191, 36, 0.9)); }
        }

        .hero p {
            color: var(--text-muted);
            font-size: 16px;
            margin-bottom: 36px;
            line-height: 1.6;
            max-width: 680px;
            margin-left: auto;
            margin-right: auto;
            font-weight: 500;
        }

        .hero-action-buttons {
            display: flex;
            justify-content: center;
            gap: 20px;
            flex-wrap: wrap;
            margin-bottom: 40px;
        }

        .btn-glow-gold {
            font-size: 15px;
            font-weight: 900;
            letter-spacing: 1px;
            text-transform: uppercase;
            background: linear-gradient(135deg, #b45309, #d4af37, #fbbf24);
            border: 2px solid var(--gold-bright);
            color: #000000;
            padding: 16px 38px;
            border-radius: 10px;
            cursor: pointer;
            box-shadow: 0 0 30px rgba(212, 175, 55, 0.7);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .btn-glow-gold:hover {
            transform: translateY(-3px) scale(1.03);
            box-shadow: 0 0 45px rgba(251, 191, 36, 1);
            filter: brightness(1.15);
        }

        .btn-glow-store {
            font-size: 15px;
            font-weight: 900;
            letter-spacing: 1px;
            text-transform: uppercase;
            background: rgba(22, 18, 12, 0.9);
            border: 2px solid var(--gold-border);
            color: var(--gold-bright);
            padding: 16px 38px;
            border-radius: 10px;
            cursor: pointer;
            box-shadow: 0 0 20px rgba(0,0,0,0.6);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .btn-glow-store:hover {
            background: rgba(36, 30, 18, 0.95);
            border-color: var(--gold-bright);
            color: #fff;
            box-shadow: 0 0 30px var(--gold-glow);
            transform: translateY(-3px);
        }

        /* Status Cards */
        .status-container {
            max-width: 680px;
            margin: 0 auto 50px auto;
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            position: relative;
            z-index: 1;
            padding: 0 20px;
        }

        @media (max-width: 500px) { .status-container { grid-template-columns: 1fr; } }

        .status-card {
            background: var(--bg-card);
            border: 1px solid var(--gold-border);
            padding: 26px;
            border-radius: 14px;
            box-shadow: 0 10px 35px rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(12px);
            text-align: center;
            transition: all 0.25s ease;
        }

        .status-card:hover {
            border-color: var(--gold-bright);
            box-shadow: 0 0 30px var(--gold-glow);
            transform: translateY(-3px);
        }

        .status-card h4 {
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--gold-bright);
            margin-bottom: 8px;
            font-weight: 800;
        }

        .status-card .val {
            font-size: 32px;
            font-weight: 900;
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }

        /* Modals */
        .portal-modal {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.92);
            backdrop-filter: blur(14px);
            z-index: 100;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .portal-box {
            background: #0f0d0a;
            border: 2px solid var(--gold-primary);
            border-radius: 18px;
            width: 920px;
            max-width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 0 60px rgba(212, 175, 55, 0.55);
            padding: 34px;
            animation: popIn 0.25s ease;
        }

        @keyframes popIn {
            from { transform: scale(0.92); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .portal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--gold-border);
        }

        .portal-header h3 {
            font-size: 22px;
            font-weight: 900;
            color: var(--gold-bright);
            letter-spacing: 1px;
        }

        /* Auth Forms */
        .auth-tabs {
            display: flex;
            border-bottom: 2px solid var(--gold-border);
            margin-bottom: 22px;
            gap: 10px;
        }

        .auth-tab-btn {
            flex: 1;
            background: transparent;
            border: none;
            padding: 12px;
            color: var(--text-muted);
            font-weight: 800;
            font-size: 15px;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            transition: all 0.2s ease;
        }

        .auth-tab-btn.active {
            color: var(--gold-bright);
            border-bottom-color: var(--gold-bright);
        }

        .form-group {
            margin-bottom: 16px;
            text-align: left;
        }

        .form-group label {
            display: block;
            font-size: 13px;
            font-weight: 700;
            color: var(--gold-light);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .form-helper {
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 4px;
        }

        .auth-input {
            width: 100%;
            background: #050403;
            border: 1px solid var(--gold-border);
            padding: 14px 16px;
            border-radius: 8px;
            color: #ffffff;
            font-size: 15px;
            font-weight: 600;
            outline: none;
            transition: all 0.2s ease;
        }

        .auth-input:focus {
            border-color: var(--gold-bright);
            box-shadow: 0 0 15px var(--gold-glow);
        }

        .alert-box {
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 16px;
            font-size: 13px;
            font-weight: 700;
            display: none;
        }

        .alert-error {
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.5);
            color: #fca5a5;
        }

        .alert-success {
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid rgba(16, 185, 129, 0.5);
            color: #6ee7b7;
        }

        /* Account Details Box */
        .account-hero-box {
            background: rgba(26, 22, 14, 0.9);
            border: 1px solid var(--gold-border);
            border-radius: 14px;
            padding: 24px;
            margin-bottom: 24px;
            text-align: center;
        }

        .unique-code-box {
            background: #060504;
            border: 2px dashed var(--gold-bright);
            border-radius: 12px;
            padding: 18px;
            margin: 16px 0;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            flex-wrap: wrap;
        }

        .code-number {
            font-size: 34px;
            font-weight: 900;
            letter-spacing: 6px;
            color: var(--gold-bright);
            text-shadow: 0 0 25px var(--gold-glow);
        }

        .btn-copy-code {
            background: rgba(212, 175, 55, 0.25);
            border: 1px solid var(--gold-primary);
            color: var(--gold-light);
            padding: 8px 18px;
            border-radius: 6px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .btn-copy-code:hover {
            background: var(--gold-primary);
            color: #000;
            box-shadow: 0 0 15px var(--gold-glow);
        }

        .char-stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
            margin-top: 16px;
        }

        .stat-badge {
            background: #0d0a06;
            border: 1px solid #382c16;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }

        .stat-badge .lbl { font-size: 11px; text-transform: uppercase; color: var(--gold-bright); font-weight: 800; }
        .stat-badge .val { font-size: 16px; font-weight: 900; color: #fff; margin-top: 4px; }

        /* Shop Grid */
        .shop-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 20px;
        }

        .shop-card {
            background: rgba(24, 20, 14, 0.85);
            border: 1px solid var(--gold-border);
            border-radius: 12px;
            padding: 22px;
            text-align: center;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: all 0.25s ease;
        }

        .shop-card:hover {
            border-color: var(--gold-bright);
            transform: translateY(-4px);
            box-shadow: 0 8px 30px var(--gold-glow);
            background: rgba(36, 30, 20, 0.95);
        }

        .shop-card-badge {
            background: rgba(212, 175, 55, 0.2);
            color: var(--gold-light);
            border: 1px solid var(--gold-primary);
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 800;
            display: inline-block;
            margin-bottom: 12px;
            text-transform: uppercase;
        }

        .shop-card h4 { font-size: 19px; font-weight: 900; color: #ffffff; margin-bottom: 6px; }
        .shop-card .price { font-size: 22px; font-weight: 900; color: var(--gold-bright); margin-bottom: 14px; }

        .shop-perks-list {
            text-align: left;
            font-size: 13px;
            color: var(--text-muted);
            line-height: 1.6;
            margin-bottom: 20px;
            list-style: none;
        }

        .shop-perks-list li {
            position: relative;
            padding-left: 16px;
            margin-bottom: 6px;
        }

        .shop-perks-list li::before {
            content: "•";
            position: absolute;
            left: 0;
            color: var(--gold-bright);
            font-weight: bold;
        }

        .btn-buy {
            background: linear-gradient(135deg, #d4af37, #fbbf24);
            border: 1px solid #fde047;
            color: #000000;
            padding: 12px;
            border-radius: 8px;
            font-weight: 900;
            font-size: 14px;
            cursor: pointer;
            width: 100%;
            transition: all 0.2s ease;
        }

        .btn-buy:hover { box-shadow: 0 0 20px var(--gold-glow); filter: brightness(1.1); }

        .btn-danger {
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.5);
            color: #fca5a5;
            padding: 10px 18px;
            border-radius: 8px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .btn-danger:hover {
            background: rgba(239, 68, 68, 0.3);
            color: #fff;
        }

        /* Platform Tabs & Guides */
        .platform-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 24px;
            flex-wrap: wrap;
        }

        .plat-btn {
            background: rgba(22, 18, 12, 0.85);
            border: 1px solid var(--gold-border);
            color: var(--text-muted);
            padding: 10px 22px;
            border-radius: 8px;
            font-weight: 800;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .plat-btn:hover { color: white; border-color: var(--gold-bright); }
        .plat-btn.active {
            background: linear-gradient(135deg, #b45309, #d4af37);
            border-color: var(--gold-bright);
            color: #000000;
            box-shadow: 0 0 25px var(--gold-glow);
        }

        .guide-container {
            background: #14100b;
            border: 1px solid var(--gold-border);
            border-radius: 14px;
            padding: 26px;
            display: flex;
            flex-direction: column;
            gap: 22px;
        }

        .step-item { display: flex; gap: 18px; }
        .step-num {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: rgba(212, 175, 55, 0.25);
            border: 2px solid var(--gold-primary);
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 900;
            font-size: 16px;
            flex-shrink: 0;
            box-shadow: 0 0 12px var(--gold-glow);
        }

        .step-content h4 { font-size: 17px; font-weight: 800; color: #ffffff; margin-bottom: 4px; }
        .step-content p { font-size: 14px; color: var(--text-muted); line-height: 1.5; font-weight: 500; }

        .code-snippet {
            background: #050403;
            border: 1px solid #382c16;
            padding: 10px 14px;
            border-radius: 6px;
            color: var(--gold-bright);
            font-family: 'Courier New', monospace;
            font-size: 13px;
            margin-top: 8px;
            word-break: break-all;
        }

        .guide-btn {
            background: rgba(212, 175, 55, 0.2);
            border: 1px solid var(--gold-primary);
            color: var(--gold-light);
            padding: 9px 18px;
            border-radius: 6px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            margin-top: 10px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .guide-btn:hover { background: var(--gold-primary); color: #000; box-shadow: 0 0 15px var(--gold-glow); }
        .apk-card {
            background: rgba(212, 175, 55, 0.08);
            border: 1px dashed var(--gold-primary);
            border-radius: 12px;
            padding: 18px;
            margin-bottom: 22px;
        }

        /* Language Modal */
        .lang-modal {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.94);
            backdrop-filter: blur(16px);
            z-index: 200;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .lang-box {
            background: #110e0a;
            border: 2px solid var(--gold-primary);
            border-radius: 20px;
            padding: 40px;
            text-align: center;
            max-width: 480px;
            width: 90%;
            box-shadow: 0 0 70px rgba(212, 175, 55, 0.6);
            animation: popIn 0.3s ease;
        }

        .lang-box h3 { font-size: 24px; font-weight: 900; color: var(--gold-bright); margin-bottom: 6px; letter-spacing: 1px; }
        .lang-options { display: flex; gap: 16px; margin-top: 26px; }

        .lang-choice-btn {
            flex: 1;
            background: rgba(26, 22, 16, 0.9);
            border: 2px solid var(--gold-border);
            padding: 22px 16px;
            border-radius: 14px;
            color: white;
            font-weight: 800;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.25s ease;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
        }

        .lang-choice-btn:hover {
            border-color: var(--gold-bright);
            background: rgba(212, 175, 55, 0.25);
            box-shadow: 0 0 35px var(--gold-glow);
            transform: translateY(-4px);
        }

        .choice-flag { width: 50px; height: 33px; border-radius: 4px; box-shadow: 0 0 15px rgba(0,0,0,0.6); object-fit: cover; }
    </style>
</head>
<body>
    <canvas id="gold-canvas"></canvas>

    <!-- Background Audio Loop -->
    <audio id="bgAudio" loop preload="auto">
        <source src="https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=cyberpunk-2099-10701.mp3" type="audio/mpeg">
    </audio>

    <!-- Language Selector Modal -->
    <div class="lang-modal" id="langModal">
        <div class="lang-box">
            <img src="/logo.png" alt="VOID" style="max-width: 170px; margin-bottom: 14px; filter: drop-shadow(0 0 20px var(--gold-glow));">
            <h3>SELECT LANGUAGE</h3>
            <p style="color: var(--text-muted); font-size: 14px; font-weight: 600;">PILIH BAHASA ANDA UNTUK MELANJUTKAN</p>
            <div class="lang-options">
                <button class="lang-choice-btn" onclick="setLanguage('en')">
                    <img src="https://flagcdn.com/w80/gb.png" alt="English" class="choice-flag">
                    <span>ENGLISH</span>
                </button>
                <button class="lang-choice-btn" onclick="setLanguage('id')">
                    <img src="https://flagcdn.com/w80/id.png" alt="Indonesia" class="choice-flag">
                    <span>INDONESIA</span>
                </button>
            </div>
        </div>
    </div>

    <!-- Navigation -->
    <nav class="navbar">
        <div class="nav-socials">
            <a href="https://discord.gg" target="_blank" class="social-btn discord" title="Join Discord">
                <svg viewBox="0 0 127.14 96.36">
                    <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,45.91,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,45.91,96.12,53,91.08,65.69,84.69,65.69Z"/>
                </svg>
            </a>
            <a href="https://whatsapp.com" target="_blank" class="social-btn whatsapp" title="WhatsApp Group">
                <svg viewBox="0 0 448 512">
                    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/>
                </svg>
            </a>
        </div>
        <div class="nav-controls">
            <button class="auth-status-btn" id="authNavBtn" onclick="handleAuthNavClick()">
                <span id="authNavIcon">👤</span>
                <span id="authNavText">LOGIN / REGISTER</span>
            </button>
            <button class="audio-toggle-btn" onclick="toggleAudio()" id="audioBtn">
                <span id="audioIcon">OFF</span> <span id="audioTxt">MUSIC</span>
            </button>
            <button class="lang-switch-btn" onclick="openLanguageModal()">
                <img src="https://flagcdn.com/w80/gb.png" id="currentLangFlag" alt="Language" class="flag-img">
                <span id="currentLangText">ENGLISH</span>
            </button>
        </div>
    </nav>

    <!-- Hero -->
    <section class="hero">
        <img src="/logo.png" alt="VOID Private Server" class="main-logo-img">
        <p id="heroDesc">Connect to the fastest, zero-lag GTPS Cloud server. Join thousands of champions, conquer custom bosses, and trade in our rich economy.</p>
        
        <div class="hero-action-buttons">
            <button class="btn-glow-gold" onclick="openTutorial('windows')">
                <span id="btnHowToPlayText">HOW TO PLAY</span>
            </button>
            <button class="btn-glow-store" onclick="openShopModal()">
                <span id="btnStoreText">SHOP ASSETS</span>
            </button>
        </div>
    </section>

    <!-- Status Cards -->
    <section class="status-container">
        <div class="status-card">
            <h4 id="lblServerStatus">SERVER STATUS</h4>
            <div class="val">
                <span id="statusDot" style="width:14px; height:14px; border-radius:50%; background:var(--online-green); box-shadow:0 0 14px var(--online-green);"></span>
                <span id="statusText">ONLINE</span>
            </div>
        </div>
        <div class="status-card">
            <h4 id="lblOnlinePlayers">ONLINE PLAYERS</h4>
            <div class="val" id="playerCountVal" style="color:var(--gold-bright);">1</div>
        </div>
    </section>

    <!-- LOGIN / REGISTER MODAL -->
    <div class="portal-modal" id="loginModal">
        <div class="portal-box" style="max-width: 480px;">
            <div class="portal-header">
                <h3 id="authModalHeader">PORTAL ACCESS</h3>
                <button onclick="closeLoginModal()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div class="auth-tabs">
                <button class="auth-tab-btn active" id="tabLogin" onclick="switchAuthTab('login')">SIGN IN</button>
                <button class="auth-tab-btn" id="tabRegister" onclick="switchAuthTab('register')">CREATE ACCOUNT</button>
            </div>

            <div class="alert-box alert-error" id="authErrorBox"></div>
            <div class="alert-box alert-success" id="authSuccessBox"></div>

            <!-- Login Form -->
            <form id="formLogin" onsubmit="handleLoginSubmit(event)">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="loginUsername" class="auth-input" placeholder="Enter username..." required autocomplete="username">
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="loginPassword" class="auth-input" placeholder="Enter password..." required autocomplete="current-password">
                </div>
                <button type="submit" class="btn-buy" style="margin-top: 10px;">SIGN IN</button>
            </form>

            <!-- Register Form -->
            <form id="formRegister" onsubmit="handleRegisterSubmit(event)" style="display:none;">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="regUsername" class="auth-input" placeholder="Choose username (min 4 chars)..." required minlength="4" autocomplete="username">
                    <div class="form-helper">Minimum 4 characters (letters, numbers, _ -)</div>
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="regPassword" class="auth-input" placeholder="Choose password (min 6 chars)..." required minlength="6" autocomplete="new-password">
                    <div class="form-helper">Minimum 6 characters</div>
                </div>
                <div class="form-group">
                    <label>Confirm Password</label>
                    <input type="password" id="regConfirmPassword" class="auth-input" placeholder="Repeat password..." required minlength="6" autocomplete="new-password">
                </div>
                <button type="submit" class="btn-buy" style="margin-top: 10px;">CREATE ACCOUNT</button>
            </form>
        </div>
    </div>

    <!-- LOGGED IN ACCOUNT / PROFILE MODAL -->
    <div class="portal-modal" id="accountModal">
        <div class="portal-box" style="max-width: 640px;">
            <div class="portal-header">
                <h3>ACCOUNT DASHBOARD</h3>
                <button onclick="closeAccountModal()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div class="account-hero-box">
                <div style="font-size: 13px; font-weight: 800; color: var(--gold-light); text-transform: uppercase;">WELCOME BACK</div>
                <div style="font-size: 26px; font-weight: 900; color: #fff; margin-top: 4px;" id="accUsernameDisplay">--</div>
                
                <div style="margin-top: 16px; font-size: 13px; color: var(--text-muted); font-weight: 600;">
                    YOUR PERMANENT UNIQUE LINK CODE:
                </div>
                <div class="unique-code-box">
                    <div class="code-number" id="accUniqueCode">------</div>
                    <button class="btn-copy-code" onclick="copyUniqueCode()">COPY CODE</button>
                </div>
                <p style="font-size: 12px; color: var(--text-muted);">
                    This code is permanently assigned to your account and never changes. Use it in-game to sync your GrowID.
                </p>
            </div>

            <!-- Link Status Section -->
            <div id="accUnlinkedSection" style="display:none; background: rgba(212, 175, 55, 0.08); border: 1px dashed var(--gold-primary); border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom: 12px;">
                    <span style="font-size: 20px; color: var(--gold-bright);">⚠️</span>
                    <h4 style="font-size: 16px; font-weight: 800; color: var(--gold-bright);">No In-Game Character Linked</h4>
                </div>
                <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6; margin-bottom: 14px;">
                    Follow these 3 quick steps to link your Growtopia character:
                </p>
                <div style="font-size: 13px; color: #fff; line-height: 1.8; background: #080604; padding: 14px; border-radius: 8px; border: 1px solid #382c16;">
                    1. Log into the server in Growtopia.<br>
                    2. Type <b style="color:var(--gold-bright);">/accept</b> in the chat.<br>
                    3. Enter your 6-digit code <b style="color:var(--gold-bright);" id="accCodeGuide">------</b> and submit.<br>
                    <span style="color:#10b981; font-weight:bold;">Your account will instantly verify and sync live!</span>
                </div>
            </div>

            <div id="accLinkedSection" style="display:none; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom: 14px;">
                    <div>
                        <span style="font-size: 11px; font-weight: 800; color: #10b981; text-transform: uppercase;">VERIFIED GROWID</span>
                        <h4 style="font-size: 20px; font-weight: 900; color: #ffffff; display: flex; align-items: center; gap: 8px;">
                            <span id="accLinkedGrowId">--</span>
                            <span style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: rgba(16,185,129,0.2); border: 1px solid #10b981; color: #10b981;">SYNCED</span>
                        </h4>
                    </div>
                    <button class="btn-danger" onclick="unlinkAccount()">UNLINK GROWID</button>
                </div>

                <div class="char-stats-grid">
                    <div class="stat-badge">
                        <div class="lbl">STATUS</div>
                        <div class="val" id="accLiveStatus">OFFLINE</div>
                    </div>
                    <div class="stat-badge">
                        <div class="lbl">WORLD</div>
                        <div class="val" id="accLiveWorld">--</div>
                    </div>
                    <div class="stat-badge">
                        <div class="lbl">GEMS</div>
                        <div class="val" id="accLiveGems" style="color:var(--gold-bright);">0</div>
                    </div>
                    <div class="stat-badge">
                        <div class="lbl">WORLD LOCKS</div>
                        <div class="val" id="accLiveWL" style="color:var(--gold-bright);">0</div>
                    </div>
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top: 10px;">
                <button class="btn-glow-store" style="flex:1; padding: 12px;" onclick="closeAccountModal(); openShopModal();">VISIT STORE</button>
                <button class="btn-danger" style="padding: 12px 24px;" onclick="handleLogout()">LOGOUT</button>
            </div>
        </div>
    </div>

    <!-- ROLES & ASSETS STORE MODAL -->
    <div class="portal-modal" id="shopModal">
        <div class="portal-box">
            <div class="portal-header">
                <h3 id="shopModalTitle">VOID STORE • ROLES & RANKS</h3>
                <button onclick="closeShopModal()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div class="shop-grid">
                <!-- VIP -->
                <div class="shop-card">
                    <div>
                        <span class="shop-card-badge">ROLE RANK (ID 1)</span>
                        <h4>VIP MEMBER</h4>
                        <div class="price">100 DL ($3)</div>
                        <ul class="shop-perks-list">
                            <li>[VIP] Gold Chat Tag & Glow</li>
                            <li>+15% Extra Gems Drop Boost</li>
                            <li>Access to /weather & VIP Worlds</li>
                            <li>Buyable in-game via <b>/buyvip</b></li>
                        </ul>
                    </div>
                    <button class="btn-buy" onclick="contactBuy('VIP Member')">PURCHASE VIP</button>
                </div>

                <!-- SUPER VIP -->
                <div class="shop-card">
                    <div>
                        <span class="shop-card-badge">ROLE RANK (ID 2)</span>
                        <h4>SUPER VIP</h4>
                        <div class="price">250 DL ($6)</div>
                        <ul class="shop-perks-list">
                            <li>[SUPER VIP] Cyan Glow Title</li>
                            <li>+30% Extra Gems on all actions</li>
                            <li>Auto-collect & Auto-farm Speed</li>
                            <li>Exclusive SVIP Lounge World</li>
                        </ul>
                    </div>
                    <button class="btn-buy" onclick="contactBuy('Super VIP')">PURCHASE SVIP</button>
                </div>

                <!-- MODERATOR -->
                <div class="shop-card" style="border-color: var(--gold-bright); box-shadow: 0 0 25px rgba(212,175,55,0.35);">
                    <div>
                        <span class="shop-card-badge" style="background:var(--gold-primary); color:#000;">STAFF RANK (ID 3)</span>
                        <h4>MODERATOR</h4>
                        <div class="price">500 DL ($12)</div>
                        <ul class="shop-perks-list">
                            <li>[MOD] Official Colored Title</li>
                            <li>Full /pinfo & Security Inspector</li>
                            <li>Mute, Curse, Warn & Kick Rights</li>
                            <li>Priority Slot & Staff Lounge</li>
                        </ul>
                    </div>
                    <button class="btn-buy" style="background:linear-gradient(135deg, #f59e0b, #ffd700);" onclick="contactBuy('Moderator Rank')">PURCHASE MOD</button>
                </div>

                <!-- ADMIN -->
                <div class="shop-card">
                    <div>
                        <span class="shop-card-badge">STAFF RANK (ID 4)</span>
                        <h4>ADMINISTRATOR</h4>
                        <div class="price">1,000 DL ($20)</div>
                        <ul class="shop-perks-list">
                            <li>[ADMIN] Red Master Title</li>
                            <li>Global Server Broadcast access</li>
                            <li>Ban, Pull, Unban & Curse controls</li>
                            <li>Direct Developer contact line</li>
                        </ul>
                    </div>
                    <button class="btn-buy" onclick="contactBuy('Administrator')">PURCHASE ADMIN</button>
                </div>

                <!-- COMMUNITY MANAGER -->
                <div class="shop-card">
                    <div>
                        <span class="shop-card-badge">EXECUTIVE (ID 5)</span>
                        <h4>COMMUNITY MANAGER</h4>
                        <div class="price">20 BGL ($35)</div>
                        <ul class="shop-perks-list">
                            <li>[CM] Purple Executive Title</li>
                            <li>Host Official Events & Giveaways</li>
                            <li>Custom Item Spawning rights</li>
                            <li>Server Economy control channel</li>
                        </ul>
                    </div>
                    <button class="btn-buy" onclick="contactBuy('Community Manager')">PURCHASE CM</button>
                </div>

                <!-- DEVELOPER / GOD -->
                <div class="shop-card">
                    <div>
                        <span class="shop-card-badge">ULTIMATE (ID 7 & 51)</span>
                        <h4>DEV & GOD TIER</h4>
                        <div class="price">CUSTOM ($50+)</div>
                        <ul class="shop-perks-list">
                            <li>[GOD] / [DEV] Custom Tag</li>
                            <li>Custom Item & Set Design in server</li>
                            <li>Full Command and System Access</li>
                            <li>Lifetime VIP & Special Perks</li>
                        </ul>
                    </div>
                    <button class="btn-buy" onclick="contactBuy('Dev & God Tier')">CONTACT OWNER</button>
                </div>
            </div>
        </div>
    </div>

    <!-- TUTORIAL MODAL -->
    <div class="portal-modal" id="tutorialModal">
        <div class="portal-box">
            <div class="portal-header">
                <h3 id="tutorialModalTitle">HOW TO PLAY ON VOIDPS</h3>
                <button onclick="closeTutorial()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div class="platform-tabs">
                <button class="plat-btn active" onclick="switchPlatform('windows')">Windows</button>
                <button class="plat-btn" onclick="switchPlatform('android')">Android</button>
                <button class="plat-btn" onclick="switchPlatform('ios')">iOS (Surge 5)</button>
                <button class="plat-btn" onclick="switchPlatform('macos')">macOS</button>
            </div>

            <!-- WINDOWS GUIDE -->
            <div id="guide-windows" class="guide-content">
                <div class="guide-container">
                    <div class="step-item">
                        <div class="step-num">1</div>
                        <div class="step-content">
                            <h4 id="winStep1Title">Run Notepad as Administrator</h4>
                            <p id="winStep1Desc">Right-click Notepad and choose "Run as Administrator".</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">2</div>
                        <div class="step-content">
                            <h4 id="winStep2Title">Open hosts file</h4>
                            <p id="winStep2Desc">Go to File -> Open and navigate to:</p>
                            <div class="code-snippet">C:\\Windows\\System32\\drivers\\etc\\hosts</div>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">3</div>
                        <div class="step-content">
                            <h4 id="winStep3Title">Add entries</h4>
                            <p id="winStep3Desc">Click Copy Hosts, paste the two lines at the bottom of the file, then Save (Ctrl + S).</p>
                            <button class="guide-btn" onclick="copyToClipboard('5.39.13.16 growtopia1.com\\n5.39.13.16 growtopia2.com')"><span id="btnCopyHosts">Copy Hosts</span></button>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">4</div>
                        <div class="step-content">
                            <h4 id="winStep4Title">Launch Growtopia</h4>
                            <p id="winStep4Desc">Open Growtopia and click Play.</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ANDROID GUIDE -->
            <div id="guide-android" class="guide-content" style="display:none;">
                <div class="apk-card">
                    <h5 style="color:var(--gold-bright); font-size:13px; font-weight:800; letter-spacing:1px; margin-bottom:4px;" id="apkOptional">OPTIONAL • Quick Setup with APK</h5>
                    <p style="font-size:13px; color:var(--text-muted); margin-bottom:12px;" id="apkDesc">Want to play without doing any other steps? Download .apk file and install it and you're ready to play! (Connects you directly to GTPS Cloud).</p>
                    <button class="guide-btn" style="background:var(--gold-primary); color:#000;" onclick="alert('Downloading APK...')"><span id="btnDownloadApk">Download GTPS Cloud APK</span></button>
                </div>
                <div class="guide-container">
                    <div class="step-item">
                        <div class="step-num">1</div>
                        <div class="step-content">
                            <h4 id="andStep1Title">Install PowerTunnel</h4>
                            <p id="andStep1Desc">Download from official releases and install the APK on your device.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">2</div>
                        <div class="step-content">
                            <h4 id="andStep2Title">Configure Host Settings</h4>
                            <p id="andStep2Desc">Open PowerTunnel -> ☰ -> Host Settings -> Host list URL.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">3</div>
                        <div class="step-content">
                            <h4 id="andStep3Title">Paste URL</h4>
                            <p id="andStep3Desc">Click Copy URL and paste it into PowerTunnel.</p>
                            <div style="display:flex; gap:10px;">
                                <button class="guide-btn" onclick="copyToClipboard('https://api.gtps.cloud/hosts/25741')">Copy URL</button>
                                <button class="guide-btn" onclick="alert('Downloading vHost...')">Download vHost</button>
                            </div>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">4</div>
                        <div class="step-content">
                            <h4 id="andStep4Title">Start</h4>
                            <p id="andStep4Desc">Set Update period to On start, then press Start.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">5</div>
                        <div class="step-content">
                            <h4 id="andStep5Title">Launch Growtopia</h4>
                            <p id="andStep5Desc">Open Growtopia and click Play.</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- IOS GUIDE -->
            <div id="guide-ios" class="guide-content" style="display:none;">
                <div class="guide-container">
                    <div class="step-item">
                        <div class="step-num">1</div>
                        <div class="step-content">
                            <h4 id="iosStep1Title">Install Surge 5</h4>
                            <p id="iosStep1Desc">Download and install Surge 5 from the App Store.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">2</div>
                        <div class="step-content">
                            <h4 id="iosStep2Title">Import Profile</h4>
                            <p id="iosStep2Desc">Open Default.conf -> tap IMPORT -> Download Profile from URL.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">3</div>
                        <div class="step-content">
                            <h4 id="iosStep3Title">Paste URL and Setup</h4>
                            <p id="iosStep3Desc">Click Copy URL, paste into Surge, then tap SETUP and allow the VPN profile.</p>
                            <button class="guide-btn" onclick="copyToClipboard('https://api.gtps.cloud/surge/25741')">Copy URL</button>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">4</div>
                        <div class="step-content">
                            <h4 id="iosStep4Title">Launch Growtopia</h4>
                            <p id="iosStep4Desc">Open Growtopia and click Play.</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- MACOS GUIDE -->
            <div id="guide-macos" class="guide-content" style="display:none;">
                <div class="guide-container">
                    <div class="step-item">
                        <div class="step-num">1</div>
                        <div class="step-content">
                            <h4 id="macStep1Title">Open Terminal</h4>
                            <p id="macStep1Desc">Open Terminal via Spotlight -> type "Terminal" and press Enter.</p>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">2</div>
                        <div class="step-content">
                            <h4 id="macStep2Title">Edit hosts file</h4>
                            <p id="macStep2Desc">Run the following command:</p>
                            <div class="code-snippet">sudo nano /etc/hosts</div>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">3</div>
                        <div class="step-content">
                            <h4 id="macStep3Title">Add entries</h4>
                            <p id="macStep3Desc">Click Copy Hosts, paste the two lines at the bottom of the file, then save with Ctrl+X then Y.</p>
                            <button class="guide-btn" onclick="copyToClipboard('5.39.13.16 growtopia1.com\\n5.39.13.16 growtopia2.com')">Copy Hosts</button>
                        </div>
                    </div>
                    <div class="step-item">
                        <div class="step-num">4</div>
                        <div class="step-content">
                            <h4 id="macStep4Title">Launch Growtopia</h4>
                            <p id="macStep4Desc">Open Growtopia and click Play.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentLang = localStorage.getItem('voidps_lang') || 'en';
        let audioPlaying = false;
        let authToken = localStorage.getItem('voidps_token') || null;
        let currentUser = null;
        let profilePollTimer = null;

        function toggleAudio() {
            const audio = document.getElementById('bgAudio');
            const icon = document.getElementById('audioIcon');
            if (audioPlaying) {
                audio.pause();
                audioPlaying = false;
                icon.innerText = 'OFF';
            } else {
                audio.play().then(() => {
                    audioPlaying = true;
                    icon.innerText = 'ON';
                }).catch(e => console.log(e));
            }
        }

        function handleAuthNavClick() {
            if (currentUser) {
                openAccountModal();
            } else {
                openLoginModal();
            }
        }

        function openLoginModal() {
            document.getElementById('authErrorBox').style.display = 'none';
            document.getElementById('authSuccessBox').style.display = 'none';
            document.getElementById('loginModal').style.display = 'flex';
        }

        function closeLoginModal() {
            document.getElementById('loginModal').style.display = 'none';
        }

        function openAccountModal() {
            if (!currentUser) {
                openLoginModal();
                return;
            }
            renderAccountDashboard();
            document.getElementById('accountModal').style.display = 'flex';
        }

        function closeAccountModal() {
            document.getElementById('accountModal').style.display = 'none';
        }

        function switchAuthTab(tab) {
            const tabLogin = document.getElementById('tabLogin');
            const tabRegister = document.getElementById('tabRegister');
            const formLogin = document.getElementById('formLogin');
            const formRegister = document.getElementById('formRegister');
            const errBox = document.getElementById('authErrorBox');
            const succBox = document.getElementById('authSuccessBox');

            errBox.style.display = 'none';
            succBox.style.display = 'none';

            if (tab === 'login') {
                tabLogin.classList.add('active');
                tabRegister.classList.remove('active');
                formLogin.style.display = 'block';
                formRegister.style.display = 'none';
            } else {
                tabRegister.classList.add('active');
                tabLogin.classList.remove('active');
                formRegister.style.display = 'block';
                formLogin.style.display = 'none';
            }
        }

        async function handleLoginSubmit(e) {
            e.preventDefault();
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;
            const errBox = document.getElementById('authErrorBox');
            const succBox = document.getElementById('authSuccessBox');

            errBox.style.display = 'none';
            succBox.style.display = 'none';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (data.success) {
                    authToken = data.token;
                    currentUser = data.user;
                    localStorage.setItem('voidps_token', authToken);
                    succBox.innerText = 'Login successful! Opening dashboard...';
                    succBox.style.display = 'block';
                    updateNavUserState();
                    setTimeout(() => {
                        closeLoginModal();
                        openAccountModal();
                    }, 600);
                } else {
                    errBox.innerText = data.error || 'Login failed';
                    errBox.style.display = 'block';
                }
            } catch (err) {
                errBox.innerText = 'Connection error. Please try again.';
                errBox.style.display = 'block';
            }
        }

        async function handleRegisterSubmit(e) {
            e.preventDefault();
            const username = document.getElementById('regUsername').value.trim();
            const password = document.getElementById('regPassword').value;
            const confirmPassword = document.getElementById('regConfirmPassword').value;
            const errBox = document.getElementById('authErrorBox');
            const succBox = document.getElementById('authSuccessBox');

            errBox.style.display = 'none';
            succBox.style.display = 'none';

            if (username.length < 4) {
                errBox.innerText = 'Username must be at least 4 characters.';
                errBox.style.display = 'block';
                return;
            }

            if (password.length < 6) {
                errBox.innerText = 'Password must be at least 6 characters.';
                errBox.style.display = 'block';
                return;
            }

            if (password !== confirmPassword) {
                errBox.innerText = 'Passwords do not match!';
                errBox.style.display = 'block';
                return;
            }

            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (data.success) {
                    authToken = data.token;
                    currentUser = data.user;
                    localStorage.setItem('voidps_token', authToken);
                    succBox.innerText = 'Account created successfully! Your unique link code has been generated.';
                    succBox.style.display = 'block';
                    updateNavUserState();
                    setTimeout(() => {
                        closeLoginModal();
                        openAccountModal();
                    }, 800);
                } else {
                    errBox.innerText = data.error || 'Registration failed';
                    errBox.style.display = 'block';
                }
            } catch (err) {
                errBox.innerText = 'Connection error. Please try again.';
                errBox.style.display = 'block';
            }
        }

        async function fetchUserProfile() {
            if (!authToken) {
                updateNavUserState();
                return;
            }
            try {
                const res = await fetch('/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.success) {
                        currentUser = data.user;
                        updateNavUserState();
                        renderAccountDashboard();
                    }
                } else {
                    currentUser = null;
                    authToken = null;
                    localStorage.removeItem('voidps_token');
                    updateNavUserState();
                }
            } catch (e) {
                console.error(e);
            }
        }

        function updateNavUserState() {
            const navText = document.getElementById('authNavText');
            if (currentUser) {
                if (currentUser.linkedGrowId) {
                    navText.innerText = currentUser.username + ' • ' + currentUser.linkedGrowId;
                } else {
                    navText.innerText = currentUser.username + ' (LINK CODE)';
                }
            } else {
                navText.innerText = 'LOGIN / REGISTER';
            }
        }

        function renderAccountDashboard() {
            if (!currentUser) return;

            document.getElementById('accUsernameDisplay').innerText = currentUser.username;
            document.getElementById('accUniqueCode').innerText = currentUser.uniqueCode;
            document.getElementById('accCodeGuide').innerText = currentUser.uniqueCode;

            const unlinkedSec = document.getElementById('accUnlinkedSection');
            const linkedSec = document.getElementById('accLinkedSection');

            if (currentUser.linkedGrowId) {
                unlinkedSec.style.display = 'none';
                linkedSec.style.display = 'block';
                document.getElementById('accLinkedGrowId').innerText = currentUser.linkedGrowId;

                const stats = currentUser.liveStats;
                if (stats && stats.isOnline) {
                    document.getElementById('accLiveStatus').innerText = 'ONLINE';
                    document.getElementById('accLiveStatus').style.color = '#10b981';
                    document.getElementById('accLiveWorld').innerText = stats.world || 'EXIT';
                    document.getElementById('accLiveGems').innerText = (stats.gems || 0).toLocaleString();
                    document.getElementById('accLiveWL').innerText = (stats.wl || 0).toLocaleString();
                } else {
                    document.getElementById('accLiveStatus').innerText = 'OFFLINE';
                    document.getElementById('accLiveStatus').style.color = '#ef4444';
                    document.getElementById('accLiveWorld').innerText = 'OFFLINE';
                    document.getElementById('accLiveGems').innerText = stats ? (stats.gems || 0).toLocaleString() : '0';
                    document.getElementById('accLiveWL').innerText = stats ? (stats.wl || 0).toLocaleString() : '0';
                }
            } else {
                unlinkedSec.style.display = 'block';
                linkedSec.style.display = 'none';
            }
        }

        function copyUniqueCode() {
            if (currentUser && currentUser.uniqueCode) {
                navigator.clipboard.writeText(currentUser.uniqueCode);
                alert('Copied Unique Link Code: ' + currentUser.uniqueCode);
            }
        }

        async function unlinkAccount() {
            if (!confirm('Are you sure you want to unlink this GrowID?')) return;
            try {
                const res = await fetch('/api/auth/unlink', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
                const data = await res.json();
                if (data.success) {
                    currentUser.linkedGrowId = null;
                    currentUser.liveStats = null;
                    renderAccountDashboard();
                    updateNavUserState();
                }
            } catch (e) {
                alert('Error unlinking account');
            }
        }

        async function handleLogout() {
            try {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
            } catch (e) {}
            currentUser = null;
            authToken = null;
            localStorage.removeItem('voidps_token');
            closeAccountModal();
            updateNavUserState();
        }

        const TRANSLATIONS = {
            en: {
                flagSrc: 'https://flagcdn.com/w80/gb.png',
                langText: 'ENGLISH',
                heroDesc: 'Connect to the fastest, zero-lag GTPS Cloud server. Join thousands of champions, conquer custom bosses, and trade in our rich economy.',
                btnHowToPlay: 'HOW TO PLAY',
                btnStore: 'SHOP ASSETS',
                lblStatus: 'SERVER STATUS',
                lblOnline: 'ONLINE PLAYERS',
                modalTitle: 'HOW TO PLAY ON VOIDPS',
                shopTitle: 'VOID STORE • ROLES & RANKS',
                winStep1T: 'Run Notepad as Administrator',
                winStep1D: 'Right-click Notepad and choose "Run as Administrator".',
                winStep2T: 'Open hosts file',
                winStep2D: 'Go to File -> Open and navigate to:',
                winStep3T: 'Add entries',
                winStep3D: 'Click Copy Hosts, paste the two lines at the bottom of the file, then Save (Ctrl + S).',
                winStep4T: 'Launch Growtopia',
                winStep4D: 'Open Growtopia and click Play.',
                apkOpt: 'OPTIONAL • Quick Setup with APK',
                apkD: 'Want to play without doing any other steps? Download .apk file and install it and you are ready to play! (Connects you directly to GTPS Cloud).',
                btnApk: 'Download GTPS Cloud APK',
                andStep1T: 'Install PowerTunnel',
                andStep1D: 'Download from official releases and install the APK on your device.',
                andStep2T: 'Configure Host Settings',
                andStep2D: 'Open PowerTunnel -> ☰ -> Host Settings -> Host list URL.',
                andStep3T: 'Paste URL',
                andStep3D: 'Click Copy URL and paste it into PowerTunnel.',
                andStep4T: 'Start',
                andStep4D: 'Set Update period to On start, then press Start.',
                andStep5T: 'Launch Growtopia',
                andStep5D: 'Open Growtopia and click Play.',
                iosStep1T: 'Install Surge 5',
                iosStep1D: 'Download and install Surge 5 from the App Store.',
                iosStep2T: 'Import Profile',
                iosStep2D: 'Open Default.conf -> tap IMPORT -> Download Profile from URL.',
                iosStep3T: 'Paste URL and Setup',
                iosStep3D: 'Click Copy URL, paste into Surge, then tap SETUP and allow the VPN profile.',
                iosStep4T: 'Launch Growtopia',
                iosStep4D: 'Open Growtopia and click Play.',
                macStep1T: 'Open Terminal',
                macStep1D: 'Open Terminal via Spotlight -> type "Terminal" and press Enter.',
                macStep2T: 'Edit hosts file',
                macStep2D: 'Run the following command:',
                macStep3T: 'Add entries',
                macStep3D: 'Click Copy Hosts, paste the two lines at the bottom of the file, then save with Ctrl+X then Y.',
                macStep4T: 'Launch Growtopia',
                macStep4D: 'Open Growtopia and click Play.'
            },
            id: {
                flagSrc: 'https://flagcdn.com/w80/id.png',
                langText: 'INDONESIA',
                heroDesc: 'Terhubung ke server GTPS Cloud tercepat dan tanpa lag. Bergabunglah dengan ribuan pemain, kalahkan custom boss, dan nikmati ekonomi server kami.',
                btnHowToPlay: 'CARA BERMAIN',
                btnStore: 'BELI ITEM & ROLE',
                lblStatus: 'STATUS SERVER',
                lblOnline: 'PEMAIN ONLINE',
                modalTitle: 'CARA BERMAIN DI VOIDPS',
                shopTitle: 'TOKO VOIDPS • KATALOG ROLE',
                winStep1T: 'Buka Notepad sebagai Administrator',
                winStep1D: 'Klik kanan Notepad lalu pilih "Run as Administrator".',
                winStep2T: 'Buka file hosts',
                winStep2D: 'Buka File -> Open lalu navigasi ke:',
                winStep3T: 'Tambahkan entri',
                winStep3D: 'Klik Salin Hosts, tempel kedua baris di bagian bawah file, lalu Simpan (Ctrl + S).',
                winStep4T: 'Buka Growtopia',
                winStep4D: 'Buka aplikasi Growtopia dan tekan Play.',
                apkOpt: 'OPSIONAL • Setup Cepat dengan APK',
                apkD: 'Mau main langsung tanpa repot? Unduh file .apk, pasang di HP Anda dan langsung siap main! (Terhubung langsung ke GTPS Cloud).',
                btnApk: 'Unduh GTPS Cloud APK',
                andStep1T: 'Pasang PowerTunnel',
                andStep1D: 'Unduh dari rilis resmi lalu instal file APK di perangkat Anda.',
                andStep2T: 'Konfigurasi Host Settings',
                andStep2D: 'Buka PowerTunnel -> ☰ -> Host Settings -> Host list URL.',
                andStep3T: 'Tempelkan URL',
                andStep3D: 'Klik Salin URL lalu tempelkan ke kolom PowerTunnel.',
                andStep4T: 'Mulai',
                andStep4D: 'Atur Update period ke On start, lalu tekan Start.',
                andStep5T: 'Buka Growtopia',
                andStep5D: 'Buka aplikasi Growtopia dan tekan Play.',
                iosStep1T: 'Pasang Surge 5',
                iosStep1D: 'Unduh dan pasang aplikasi Surge 5 dari App Store.',
                iosStep2T: 'Impor Profil',
                iosStep2D: 'Buka Default.conf -> tekan IMPORT -> Download Profile from URL.',
                iosStep3T: 'Tempel URL & Pasang',
                iosStep3D: 'Klik Salin URL, tempel di Surge, tekan SETUP lalu izinkan profil VPN.',
                iosStep4T: 'Buka Growtopia',
                iosStep4D: 'Buka aplikasi Growtopia dan tekan Play.',
                macStep1T: 'Buka Terminal',
                macStep1D: 'Buka Terminal via Spotlight -> ketik "Terminal" dan tekan Enter.',
                macStep2T: 'Edit file hosts',
                macStep2D: 'Jalankan perintah berikut:',
                macStep3T: 'Tambahkan entri',
                macStep3D: 'Klik Salin Hosts, tempelkan di bagian paling bawah, lalu simpan dengan Ctrl+X kemudian Y.',
                macStep4T: 'Buka Growtopia',
                macStep4D: 'Buka aplikasi Growtopia dan tekan Play.'
            }
        };

        function setLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('voidps_lang', lang);
            document.getElementById('langModal').style.display = 'none';
            applyTranslations();
            if (!audioPlaying) toggleAudio();
        }

        function openLanguageModal() {
            document.getElementById('langModal').style.display = 'flex';
        }

        function applyTranslations() {
            const t = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
            document.getElementById('currentLangFlag').src = t.flagSrc;
            document.getElementById('currentLangText').innerText = t.langText;
            document.getElementById('heroDesc').innerText = t.heroDesc;
            document.getElementById('btnHowToPlayText').innerText = t.btnHowToPlay;
            document.getElementById('btnStoreText').innerText = t.btnStore;
            document.getElementById('lblServerStatus').innerText = t.lblStatus;
            document.getElementById('lblOnlinePlayers').innerText = t.lblOnline;
            document.getElementById('tutorialModalTitle').innerText = t.modalTitle;
            document.getElementById('shopModalTitle').innerText = t.shopTitle;

            document.getElementById('winStep1Title').innerText = t.winStep1T;
            document.getElementById('winStep1Desc').innerText = t.winStep1D;
            document.getElementById('winStep2Title').innerText = t.winStep2T;
            document.getElementById('winStep2Desc').innerText = t.winStep2D;
            document.getElementById('winStep3Title').innerText = t.winStep3T;
            document.getElementById('winStep3Desc').innerText = t.winStep3D;
            document.getElementById('winStep4Title').innerText = t.winStep4T;
            document.getElementById('winStep4Desc').innerText = t.winStep4D;

            document.getElementById('apkOptional').innerText = t.apkOpt;
            document.getElementById('apkDesc').innerText = t.apkD;
            document.getElementById('btnDownloadApk').innerText = t.btnApk;
            document.getElementById('andStep1Title').innerText = t.andStep1T;
            document.getElementById('andStep1Desc').innerText = t.andStep1D;
            document.getElementById('andStep2Title').innerText = t.andStep2T;
            document.getElementById('andStep2Desc').innerText = t.andStep2D;
            document.getElementById('andStep3Title').innerText = t.andStep3T;
            document.getElementById('andStep3Desc').innerText = t.andStep3D;
            document.getElementById('andStep4Title').innerText = t.andStep4T;
            document.getElementById('andStep4Desc').innerText = t.andStep4D;
            document.getElementById('andStep5Title').innerText = t.andStep5T;
            document.getElementById('andStep5Desc').innerText = t.andStep5D;

            document.getElementById('iosStep1Title').innerText = t.iosStep1T;
            document.getElementById('iosStep1Desc').innerText = t.iosStep1D;
            document.getElementById('iosStep2Title').innerText = t.iosStep2T;
            document.getElementById('iosStep2Desc').innerText = t.iosStep2D;
            document.getElementById('iosStep3Title').innerText = t.iosStep3T;
            document.getElementById('iosStep3Desc').innerText = t.iosStep3D;
            document.getElementById('iosStep4Title').innerText = t.iosStep4T;
            document.getElementById('iosStep4Desc').innerText = t.iosStep4D;

            document.getElementById('macStep1Title').innerText = t.macStep1T;
            document.getElementById('macStep1Desc').innerText = t.macStep1D;
            document.getElementById('macStep2Title').innerText = t.macStep2T;
            document.getElementById('macStep2Desc').innerText = t.macStep2D;
            document.getElementById('macStep3Title').innerText = t.macStep3T;
            document.getElementById('macStep3Desc').innerText = t.macStep3D;
            document.getElementById('macStep4Title').innerText = t.macStep4T;
            document.getElementById('macStep4Desc').innerText = t.macStep4D;
        }

        if (localStorage.getItem('voidps_lang')) {
            document.getElementById('langModal').style.display = 'none';
        }
        applyTranslations();

        function openShopModal() { document.getElementById('shopModal').style.display = 'flex'; }
        function closeShopModal() { document.getElementById('shopModal').style.display = 'none'; }

        function contactBuy(item) {
            const userTag = (currentUser && currentUser.linkedGrowId) ? ' (Linked Character: ' + currentUser.linkedGrowId + ')' : '';
            alert('To purchase ' + item + userTag + ', please join our Discord or message WhatsApp staff!');
        }

        function openTutorial(platform) {
            document.getElementById('tutorialModal').style.display = 'flex';
            switchPlatform(platform || 'windows');
        }

        function closeTutorial() { document.getElementById('tutorialModal').style.display = 'none'; }

        function switchPlatform(plat) {
            document.querySelectorAll('.guide-content').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.plat-btn').forEach(el => el.classList.remove('active'));
            const target = document.getElementById('guide-' + plat);
            if (target) target.style.display = 'block';
            event.target.classList.add('active');
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text);
            alert('Copied to clipboard!');
        }

        /* Gold Particles */
        const canvas = document.getElementById('gold-canvas');
        const ctx = canvas.getContext('2d');
        let particles = [];

        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        class Particle {
            constructor() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.size = Math.random() * 2.5 + 1;
                this.speedX = (Math.random() - 0.5) * 0.9;
                this.speedY = -Math.random() * 1.2 - 0.3;
                this.color = Math.random() > 0.4 ? 'rgba(212, 175, 55, 0.6)' : 'rgba(251, 191, 36, 0.4)';
            }
            update() {
                this.x += this.speedX;
                this.y += this.speedY;
                if (this.y < 0) this.y = canvas.height;
                if (this.x < 0) this.x = canvas.width;
                if (this.x > canvas.width) this.x = 0;
            }
            draw() {
                ctx.fillStyle = this.color;
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        for (let i = 0; i < 65; i++) particles.push(new Particle());

        function animateCanvas() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => { p.update(); p.draw(); });
            requestAnimationFrame(animateCanvas);
        }
        animateCanvas();

        async function fetchServerStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const isOnline = data.status === 'ONLINE';

                const dot = document.getElementById('statusDot');
                const txt = document.getElementById('statusText');

                if (isOnline) {
                    dot.style.background = 'var(--online-green)';
                    dot.style.boxShadow = '0 0 14px var(--online-green)';
                    txt.innerText = 'ONLINE';
                    txt.style.color = 'var(--online-green)';
                } else {
                    dot.style.background = 'var(--offline-red)';
                    dot.style.boxShadow = '0 0 14px var(--offline-red)';
                    txt.innerText = 'OFFLINE';
                    txt.style.color = 'var(--offline-red)';
                }

                document.getElementById('playerCountVal').innerText = data.playerCount || 0;
            } catch (e) {
                console.error(e);
            }
        }

        setInterval(fetchServerStatus, 2500);
        fetchServerStatus();

        fetchUserProfile();
        setInterval(fetchUserProfile, 3000);
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(DASHBOARD_HTML);
});

app.listen(PORT, () => {
    console.log(`VOIDPS Portal running on port ${PORT}`);
});
