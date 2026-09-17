const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const GTPS_PORT = process.env.GTPS_PORT || 25741;
const GTPS_CLOUD_API = `https://api.gtps.cloud/g-api/${GTPS_PORT}/api/sync`;
const GTPS_CLOUD_STATUS_API = `https://api.gtps.cloud/g-api/${GTPS_PORT}/status`;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database File Persistence with Sessions
const DB_FILE = path.join(__dirname, 'users.json');

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                users: parsed.users || [],
                sessions: parsed.sessions || {}
            };
        }
    } catch (e) {
        console.error('Error reading database:', e);
    }
    return { users: [], sessions: {} };
}

function saveDatabase(database) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(database, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving database:', e);
    }
}

let db = loadDatabase();

function hashPassword(pwd) {
    return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

function generateUniqueCode() {
    let code;
    let exists = true;
    let attempts = 0;
    while (exists && attempts < 10000) {
        code = Math.floor(1000 + Math.random() * 9000).toString();
        exists = db.users.some(u => u.uniqueCode === code);
        attempts++;
    }
    return code || Math.floor(1000 + Math.random() * 9000).toString();
}

let serverData = {
    status: "ONLINE",
    lastHeartbeat: Date.now(),
    port: GTPS_PORT,
    playerCount: 1,
    players: [],
    logs: []
};

function processPendingLinks(pendingList) {
    if (!Array.isArray(pendingList) || pendingList.length === 0) return;

    let modified = false;
    for (const item of pendingList) {
        if (!item || !item.code || !item.growId) continue;
        const cleanCode = String(item.code).trim();
        const cleanGrowId = String(item.growId).trim();

        const user = db.users.find(u => String(u.uniqueCode).trim() === cleanCode);
        if (user && user.linkedGrowId !== cleanGrowId) {
            db.users.forEach(u => {
                if (u.id !== user.id && (u.linkedGrowId || '').toLowerCase() === cleanGrowId.toLowerCase()) {
                    u.linkedGrowId = null;
                }
            });
            user.linkedGrowId = cleanGrowId;
            modified = true;
            console.log(`[LINK SYNCED] Linked GrowID "${cleanGrowId}" to website user "${user.username}" (Code: ${cleanCode})`);
        }
    }
    if (modified) {
        saveDatabase(db);
    }
}

// Inbound push from GTPS Lua
app.all('/api/sync', (req, res) => {
    console.log(`[DEBUG-RENDER] /api/sync hit with method: ${req.method}, query:`, req.query, 'body:', req.body);
    const data = req.body || {};
    if (data.port || data.players || data.status) {
        serverData = {
            status: "ONLINE",
            lastHeartbeat: Date.now(),
            port: data.port || GTPS_PORT,
            playerCount: data.playerCount || (data.players ? data.players.length : 0),
            players: data.players || [],
            logs: data.logs || serverData.logs || []
        };
    }

    if (data.pendingLinks) {
        processPendingLinks(data.pendingLinks);
    }

    const publicUsers = db.users.map(u => ({ username: u.username, code: u.uniqueCode, linkedGrowId: u.linkedGrowId }));
    return res.json({
        success: true,
        status: serverData.status,
        playerCount: serverData.playerCount,
        usersCount: publicUsers.length,
        users: publicUsers,
        serverData: serverData
    });
});

// Periodic bidirectional polling to GTPS Cloud Gateway
async function pollGTPSCloud() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);

        const publicUsers = db.users.map(u => ({ username: u.username, code: u.uniqueCode, linkedGrowId: u.linkedGrowId }));
        const pushPayload = JSON.stringify({ users: publicUsers });

        let response = null;
        try {
            response = await fetch(GTPS_CLOUD_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: pushPayload,
                signal: controller.signal
            });
        } catch (e) {
            try {
                response = await fetch(GTPS_CLOUD_STATUS_API, { signal: controller.signal });
            } catch (err2) {}
        }

        clearTimeout(timeoutId);

        if (response && response.ok) {
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

                    if (data.pendingLinks && Array.isArray(data.pendingLinks) && data.pendingLinks.length > 0) {
                        console.log(`[DEBUG-RENDER] Received ${data.pendingLinks.length} pending link(s) from GTPS Cloud:`, data.pendingLinks);
                        processPendingLinks(data.pendingLinks);
                    }
                } catch (e) {
                    console.error('[DEBUG-RENDER] JSON Parse error from GTPS Cloud:', e.message);
                }
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

setInterval(pollGTPSCloud, 1800);
pollGTPSCloud();

app.all('/api/link-verify', (req, res) => {
    console.log(`[DEBUG-RENDER] /api/link-verify hit with method: ${req.method}, query:`, req.query, 'body:', req.body);
    const growId = (req.body && (req.body.growId || req.body.growid)) || req.query.growId || req.query.name;
    const code = (req.body && (req.body.code || req.body.uniqueCode)) || req.query.code;

    if (!growId || !code) {
        return res.status(400).json({ success: false, message: 'Missing GrowID or code', debug: { receivedBody: req.body, receivedQuery: req.query } });
    }

    const cleanGrowId = String(growId).trim();
    const cleanCode = String(code).trim();

    const user = db.users.find(u => String(u.uniqueCode).trim() === cleanCode);

    if (!user) {
        return res.status(404).json({ success: false, message: `Invalid 4-digit code: ${cleanCode}` });
    }

    db.users.forEach(u => {
        if (u.id !== user.id && (u.linkedGrowId || '').toLowerCase() === cleanGrowId.toLowerCase()) {
            u.linkedGrowId = null;
        }
    });

    user.linkedGrowId = cleanGrowId;
    saveDatabase(db);

    console.log(`[DIRECT VERIFY] Linked GrowID "${cleanGrowId}" to website user "${user.username}" (Code: ${cleanCode})`);

    return res.json({
        success: true,
        username: user.username,
        growId: user.linkedGrowId,
        message: 'Account linked successfully!'
    });
});

app.get('/api/status', (req, res) => {
    res.json(serverData);
});

// Authentication Middleware Helper
function getAuthUser(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token || !db.sessions[token]) return null;
    const userId = db.sessions[token];
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
        return res.status(400).json({ success: false, error: 'Username can only contain letters, numbers, _ or -.' });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    const existing = db.users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (existing) {
        return res.status(400).json({ success: false, error: 'Username is already taken.' });
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

    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = newUser.id;
    saveDatabase(db);

    pollGTPSCloud();

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
        return res.status(400).json({ success: false, error: 'Please enter username and password.' });
    }

    const cleanUsername = String(username).trim();
    const user = db.users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());

    if (!user || user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ success: false, error: 'Incorrect username or password.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = user.id;
    saveDatabase(db);

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
    if (token && db.sessions[token]) {
        delete db.sessions[token];
        saveDatabase(db);
    }
    return res.json({ success: true });
});

// Unlink In-Game Account
app.post('/api/auth/unlink', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    user.linkedGrowId = null;
    saveDatabase(db);
    pollGTPSCloud();

    return res.json({ success: true, message: 'Account unlinked successfully.' });
});

// Direct In-Game /link & /accept Verification Endpoint
app.post('/api/link-verify', (req, res) => {
    const { growId, code } = req.body || {};

    if (!growId || !code) {
        return res.status(400).json({ success: false, message: 'Missing GrowID or code' });
    }

    const cleanGrowId = String(growId).trim();
    const cleanCode = String(code).trim();

    const user = db.users.find(u => String(u.uniqueCode).trim() === cleanCode);

    if (!user) {
        return res.status(404).json({ success: false, message: 'Invalid 4-digit code' });
    }

    db.users.forEach(u => {
        if (u.id !== user.id && (u.linkedGrowId || '').toLowerCase() === cleanGrowId.toLowerCase()) {
            u.linkedGrowId = null;
        }
    });

    user.linkedGrowId = cleanGrowId;
    saveDatabase(db);

    console.log(`[DIRECT VERIFY] Linked GrowID "${cleanGrowId}" to website user "${user.username}" (Code: ${cleanCode})`);

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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>VOID Private Server</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-black: #080706;
            --bg-card: rgba(22, 18, 12, 0.94);
            --bg-card-hover: rgba(36, 30, 18, 0.98);
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

        * { 
            box-sizing: border-box; 
            margin: 0; 
            padding: 0; 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
            -webkit-tap-highlight-color: transparent;
        }

        html, body {
            width: 100%;
            min-height: 100%;
            background-color: var(--bg-black);
            color: var(--text-main);
            overflow-x: hidden;
            position: relative;
            background-image: 
                radial-gradient(circle at 15% 15%, rgba(212, 175, 55, 0.15) 0%, transparent 45%),
                radial-gradient(circle at 85% 15%, rgba(251, 191, 36, 0.12) 0%, transparent 45%),
                radial-gradient(circle at 50% 85%, rgba(180, 130, 20, 0.2) 0%, transparent 55%);
            padding-bottom: env(safe-area-inset-bottom);
        }

        #gold-canvas {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            pointer-events: none;
            z-index: 0;
        }

        /* Responsive Navbar */
        .navbar {
            position: relative;
            z-index: 10;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 28px;
            height: 72px;
            background: rgba(12, 10, 8, 0.96);
            border-bottom: 2px solid var(--gold-border);
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.95), 0 0 25px rgba(212, 175, 55, 0.2);
        }

        .nav-socials {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .social-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 38px;
            height: 38px;
            border-radius: 8px;
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
        .social-btn svg { width: 20px; height: 20px; fill: currentColor; }

        .nav-controls {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .user-nav-btn {
            background: rgba(212, 175, 55, 0.2);
            border: 1px solid var(--gold-border);
            color: var(--gold-bright);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
            white-space: nowrap;
        }

        .user-nav-btn:hover {
            background: var(--gold-primary);
            color: #000;
            box-shadow: 0 0 20px var(--gold-glow);
        }

        .audio-toggle-btn {
            background: rgba(212, 175, 55, 0.15);
            border: 1px solid var(--gold-border);
            color: #fff;
            padding: 8px 14px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
            white-space: nowrap;
        }

        .audio-toggle-btn:hover {
            background: rgba(212, 175, 55, 0.35);
            box-shadow: 0 0 15px var(--gold-glow);
        }

        .lang-switch-btn {
            background: rgba(212, 175, 55, 0.15);
            border: 1px solid var(--gold-border);
            color: #fff;
            padding: 8px 14px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.25s ease;
            white-space: nowrap;
        }

        .lang-switch-btn:hover {
            background: rgba(212, 175, 55, 0.35);
            box-shadow: 0 0 20px var(--gold-glow);
            transform: translateY(-2px);
        }

        .flag-img { width: 20px; height: 14px; border-radius: 2px; object-fit: cover; }

        /* Hero Section */
        .hero {
            position: relative;
            z-index: 1;
            padding: 50px 20px 24px 20px;
            text-align: center;
            max-width: 900px;
            margin: 0 auto;
        }

        .main-logo-img {
            max-width: 440px;
            width: 82%;
            height: auto;
            margin-bottom: 20px;
            filter: drop-shadow(0 0 35px rgba(212, 175, 55, 0.7));
            animation: floatLogo 3.5s ease-in-out infinite alternate;
        }

        @keyframes floatLogo {
            0% { transform: translateY(0); filter: drop-shadow(0 0 30px rgba(212, 175, 55, 0.5)); }
            100% { transform: translateY(-8px); filter: drop-shadow(0 0 55px rgba(251, 191, 36, 0.9)); }
        }

        .hero p {
            color: var(--text-muted);
            font-size: 15px;
            margin-bottom: 32px;
            line-height: 1.6;
            max-width: 660px;
            margin-left: auto;
            margin-right: auto;
            font-weight: 500;
        }

        .hero-action-buttons {
            display: flex;
            justify-content: center;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 36px;
        }

        .btn-glow-gold {
            font-size: 14px;
            font-weight: 900;
            letter-spacing: 1px;
            text-transform: uppercase;
            background: linear-gradient(135deg, #b45309, #d4af37, #fbbf24);
            border: 2px solid var(--gold-bright);
            color: #000000;
            padding: 14px 34px;
            border-radius: 10px;
            cursor: pointer;
            box-shadow: 0 0 30px rgba(212, 175, 55, 0.7);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .btn-glow-gold:hover {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 0 0 45px rgba(251, 191, 36, 1);
            filter: brightness(1.15);
        }

        .btn-glow-store {
            font-size: 14px;
            font-weight: 900;
            letter-spacing: 1px;
            text-transform: uppercase;
            background: rgba(22, 18, 12, 0.9);
            border: 2px solid var(--gold-border);
            color: var(--gold-bright);
            padding: 14px 34px;
            border-radius: 10px;
            cursor: pointer;
            box-shadow: 0 0 20px rgba(0,0,0,0.6);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 8px;
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
            max-width: 640px;
            margin: 0 auto 40px auto;
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            position: relative;
            z-index: 1;
            padding: 0 20px;
        }

        .status-card {
            background: var(--bg-card);
            border: 1px solid var(--gold-border);
            padding: 22px;
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
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--gold-bright);
            margin-bottom: 6px;
            font-weight: 800;
        }

        .status-card .val {
            font-size: 28px;
            font-weight: 900;
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        /* Responsive Modals */
        .portal-modal {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.92);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            z-index: 100;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
            overflow-y: auto;
        }

        .portal-box {
            background: #0f0d0a;
            border: 2px solid var(--gold-primary);
            border-radius: 16px;
            width: 880px;
            max-width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            box-shadow: 0 0 60px rgba(212, 175, 55, 0.55);
            padding: 28px;
            animation: popIn 0.25s ease;
        }

        @keyframes popIn {
            from { transform: scale(0.94); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .portal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 14px;
            border-bottom: 1px solid var(--gold-border);
        }

        .portal-header h3 {
            font-size: 20px;
            font-weight: 900;
            color: var(--gold-bright);
            letter-spacing: 1px;
        }

        /* Auth Forms */
        .auth-tabs {
            display: flex;
            border-bottom: 2px solid var(--gold-border);
            margin-bottom: 20px;
            gap: 10px;
        }

        .auth-tab-btn {
            flex: 1;
            background: transparent;
            border: none;
            padding: 12px;
            color: var(--text-muted);
            font-weight: 800;
            font-size: 14px;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            transition: all 0.2s ease;
        }

        .auth-tab-btn.active {
            color: var(--gold-bright);
            border-bottom-color: var(--gold-bright);
        }

        .form-group {
            margin-bottom: 14px;
            text-align: left;
        }

        .form-group label {
            display: block;
            font-size: 12px;
            font-weight: 700;
            color: var(--gold-light);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .form-helper {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 4px;
        }

        .auth-input {
            width: 100%;
            background: #050403;
            border: 1px solid var(--gold-border);
            padding: 13px 15px;
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
            background: rgba(26, 22, 14, 0.92);
            border: 1px solid var(--gold-border);
            border-radius: 14px;
            padding: 22px;
            margin-bottom: 20px;
            text-align: center;
        }

        .unique-code-box {
            background: #060504;
            border: 2px dashed var(--gold-bright);
            border-radius: 12px;
            padding: 16px;
            margin: 14px 0;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            flex-wrap: wrap;
        }

        .code-number {
            font-size: 34px;
            font-weight: 900;
            letter-spacing: 8px;
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
            grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 10px;
            margin-top: 14px;
        }

        .stat-badge {
            background: #0d0a06;
            border: 1px solid #382c16;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }

        .stat-badge .lbl { font-size: 10px; text-transform: uppercase; color: var(--gold-bright); font-weight: 800; }
        .stat-badge .val { font-size: 16px; font-weight: 900; color: #fff; margin-top: 4px; }

        /* Shop Grid */
        .shop-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 18px;
        }

        .shop-card {
            background: rgba(24, 20, 14, 0.88);
            border: 1px solid var(--gold-border);
            border-radius: 12px;
            padding: 20px;
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
            margin-bottom: 10px;
            text-transform: uppercase;
        }

        .shop-card h4 { font-size: 18px; font-weight: 900; color: #ffffff; margin-bottom: 6px; }
        .shop-card .price { font-size: 20px; font-weight: 900; color: var(--gold-bright); margin-bottom: 12px; }

        .shop-perks-list {
            text-align: left;
            font-size: 13px;
            color: var(--text-muted);
            line-height: 1.6;
            margin-bottom: 18px;
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
            padding: 10px 20px;
            border-radius: 8px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .btn-danger:hover {
            background: rgba(239, 68, 68, 0.3);
            color: #ffffff;
            box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
        }

        /* Platform Tabs & Guides */
        .platform-tabs {
            display: flex;
            gap: 8px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .plat-btn {
            background: rgba(22, 18, 12, 0.85);
            border: 1px solid var(--gold-border);
            color: var(--text-muted);
            padding: 9px 18px;
            border-radius: 8px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
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
            padding: 22px;
            display: flex;
            flex-direction: column;
            gap: 18px;
        }

        .step-item { display: flex; gap: 16px; }
        .step-num {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: rgba(212, 175, 55, 0.25);
            border: 2px solid var(--gold-primary);
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 900;
            font-size: 15px;
            flex-shrink: 0;
            box-shadow: 0 0 12px var(--gold-glow);
        }

        .step-content h4 { font-size: 16px; font-weight: 800; color: #ffffff; margin-bottom: 4px; }
        .step-content p { font-size: 13px; color: var(--text-muted); line-height: 1.5; font-weight: 500; }

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
            padding: 8px 16px;
            border-radius: 6px;
            font-weight: 800;
            font-size: 12px;
            cursor: pointer;
            margin-top: 8px;
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
            padding: 16px;
            margin-bottom: 18px;
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
            padding: 16px;
        }

        .lang-box {
            background: #110e0a;
            border: 2px solid var(--gold-primary);
            border-radius: 20px;
            padding: 34px;
            text-align: center;
            max-width: 440px;
            width: 100%;
            box-shadow: 0 0 70px rgba(212, 175, 55, 0.6);
            animation: popIn 0.3s ease;
        }

        .lang-box h3 { font-size: 22px; font-weight: 900; color: var(--gold-bright); margin-bottom: 6px; letter-spacing: 1px; }
        .lang-options { display: flex; gap: 14px; margin-top: 22px; }

        .lang-choice-btn {
            flex: 1;
            background: rgba(26, 22, 16, 0.9);
            border: 2px solid var(--gold-border);
            padding: 18px 12px;
            border-radius: 14px;
            color: white;
            font-weight: 800;
            font-size: 15px;
            cursor: pointer;
            transition: all 0.25s ease;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
        }

        .lang-choice-btn:hover {
            border-color: var(--gold-bright);
            background: rgba(212, 175, 55, 0.25);
            box-shadow: 0 0 35px var(--gold-glow);
            transform: translateY(-4px);
        }

        .choice-flag { width: 44px; height: 30px; border-radius: 4px; box-shadow: 0 0 15px rgba(0,0,0,0.6); object-fit: cover; }

        /* Gold Theme Toast Notification */
        #toastContainer {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        }

        .gold-toast {
            pointer-events: auto;
            background: #110e0a;
            border: 1px solid var(--gold-bright);
            color: #ffffff;
            padding: 14px 20px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.9), 0 0 25px rgba(212, 175, 55, 0.45);
            animation: toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            max-width: 380px;
            line-height: 1.4;
        }

        .gold-toast.toast-success {
            border-color: var(--gold-bright);
        }

        .gold-toast.toast-error {
            border-color: #ef4444;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.9), 0 0 25px rgba(239, 68, 68, 0.4);
        }

        .gold-toast-icon {
            font-size: 18px;
            color: var(--gold-bright);
            flex-shrink: 0;
        }

        @keyframes toastSlideIn {
            from { transform: translateX(100%) scale(0.9); opacity: 0; }
            to { transform: translateX(0) scale(1); opacity: 1; }
        }

        @keyframes toastFadeOut {
            from { transform: translateX(0) scale(1); opacity: 1; }
            to { transform: translateX(80%) scale(0.9); opacity: 0; }
        }

        /* Mobile Responsive Adjustments */
        @media (max-width: 768px) {
            .navbar {
                padding: 0 16px;
                height: 64px;
            }
            .user-nav-btn {
                padding: 7px 12px;
                font-size: 12px;
            }
            .audio-toggle-btn, .lang-switch-btn {
                padding: 7px 10px;
                font-size: 12px;
            }
            .hero {
                padding: 36px 16px 20px 16px;
            }
            .main-logo-img {
                width: 90%;
            }
            .btn-glow-gold, .btn-glow-store {
                padding: 12px 24px;
                font-size: 13px;
                width: 100%;
                justify-content: center;
            }
            .status-container {
                grid-template-columns: 1fr;
                gap: 12px;
                padding: 0 16px;
            }
            .portal-box {
                padding: 20px;
                border-radius: 14px;
            }
            #toastContainer {
                bottom: 16px;
                right: 16px;
                left: 16px;
                align-items: center;
            }
            .gold-toast {
                max-width: 100%;
                width: 100%;
            }
        }

        @media (max-width: 480px) {
            .nav-socials { display: none; }
            .navbar { justify-content: flex-end; gap: 8px; }
        }
    </style>
</head>
<body>
    <canvas id="gold-canvas"></canvas>

    <!-- Toast Notification Container -->
    <div id="toastContainer"></div>

    <!-- Background Audio Loop -->
    <audio id="bgAudio" loop preload="auto">
        <source src="https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=cyberpunk-2099-10701.mp3" type="audio/mpeg">
    </audio>

    <!-- Language Selector Modal -->
    <div class="lang-modal" id="langModal">
        <div class="lang-box">
            <img src="/logo.png" alt="VOID" style="max-width: 150px; margin-bottom: 12px; filter: drop-shadow(0 0 20px var(--gold-glow));">
            <h3>SELECT LANGUAGE</h3>
            <p style="color: var(--text-muted); font-size: 13px; font-weight: 600;">PILIH BAHASA ANDA UNTUK MELANJUTKAN</p>
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
            <button class="user-nav-btn" id="authNavBtn" onclick="handleAuthNavClick()">
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
                <span id="statusDot" style="width:13px; height:13px; border-radius:50%; background:var(--online-green); box-shadow:0 0 14px var(--online-green);"></span>
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
        <div class="portal-box" style="max-width: 460px;">
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
                    <div class="form-helper">Minimum 4 characters</div>
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
        <div class="portal-box" style="max-width: 540px;">
            <div class="portal-header">
                <h3>ACCOUNT DASHBOARD</h3>
                <button onclick="closeAccountModal()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div class="account-hero-box">
                <div style="font-size: 11px; font-weight: 800; color: var(--gold-light); text-transform: uppercase; letter-spacing: 1px;">AUTHENTICATED USER</div>
                <div style="font-size: 24px; font-weight: 900; color: #ffffff; margin-top: 4px;" id="accUsernameDisplay">--</div>
                
                <!-- If NOT linked, show 4-digit code -->
                <div id="accUnlinkedCodeBox" style="margin-top: 18px;">
                    <div style="font-size: 12px; color: var(--gold-bright); font-weight: 700; letter-spacing: 0.5px;">
                        YOUR 4-DIGIT IN-GAME LINK CODE:
                    </div>
                    <div class="unique-code-box">
                        <div class="code-number" id="accUniqueCode">----</div>
                        <button class="btn-copy-code" onclick="copyUniqueCode()">COPY CODE</button>
                    </div>
                    <p style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
                        To link your character, open Growtopia, type <b style="color:var(--gold-bright);">/link</b> or <b style="color:var(--gold-bright);">/accept</b> in chat, and enter your 4-digit code.
                    </p>
                </div>
            </div>

            <!-- If LINKED, show verified character & live stats -->
            <div id="accLinkedSection" style="display:none; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 12px; padding: 18px; margin-bottom: 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; flex-wrap:wrap; gap:8px;">
                    <div>
                        <span style="font-size: 11px; font-weight: 800; color: #10b981;">LINKED GROWID</span>
                        <h4 style="font-size: 19px; font-weight: 900; color: #fff;" id="accLinkedGrowId">--</h4>
                    </div>
                    <button class="btn-danger" style="padding:6px 14px; font-size:12px;" onclick="handleUnlink()">UNLINK</button>
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

            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top: 14px;">
                <button class="btn-glow-store" style="flex:1; padding: 12px;" onclick="closeAccountModal(); openShopModal();">OPEN STORE</button>
                <button class="btn-danger" onclick="handleLogout()">LOGOUT</button>
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
                            <p id="winStep3Desc">Click Copy Hosts, paste the two lines at the bottom of the file, then Save (Ctrl + S). </p>
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
                    <button class="guide-btn" style="background:var(--gold-primary); color:#000;" onclick="showToast('APK Download starting...', 'success')"><span id="btnDownloadApk">Download GTPS Cloud APK</span></button>
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
                                <button class="guide-btn" onclick="showToast('Downloading vHost...', 'success')">Download vHost</button>
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

        function showToast(message, type = 'success') {
            const container = document.getElementById('toastContainer');
            if (!container) return;

            const toast = document.createElement('div');
            toast.className = 'gold-toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
            
            const icon = document.createElement('span');
            icon.className = 'gold-toast-icon';
            icon.innerText = type === 'error' ? '✖' : '✔';

            const text = document.createElement('span');
            text.innerText = message;

            toast.appendChild(icon);
            toast.appendChild(text);
            container.appendChild(toast);

            setTimeout(() => {
                toast.style.animation = 'toastFadeOut 0.3s forwards';
                setTimeout(() => {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 300);
            }, 3000);
        }

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
                    closeLoginModal();
                    updateNavUserState();
                    renderAccountDashboard();
                    showToast('Welcome back, ' + currentUser.username + '!', 'success');
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
                    closeLoginModal();
                    updateNavUserState();
                    renderAccountDashboard();
                    showToast('Account created! Your 4-digit code is ' + currentUser.uniqueCode, 'success');
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
                        const wasUnlinked = currentUser && !currentUser.linkedGrowId;
                        currentUser = data.user;
                        if (wasUnlinked && currentUser.linkedGrowId) {
                            showToast('GrowID "' + currentUser.linkedGrowId + '" linked successfully!', 'success');
                        }
                        updateNavUserState();
                        renderAccountDashboard();
                    }
                } else if (res.status === 401) {
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
                    navText.innerText = currentUser.username.toUpperCase() + ' • ' + currentUser.linkedGrowId.toUpperCase();
                } else {
                    navText.innerText = currentUser.username.toUpperCase();
                }
            } else {
                navText.innerText = 'LOGIN / REGISTER';
            }
        }

        function renderAccountDashboard() {
            if (!currentUser) return;

            document.getElementById('accUsernameDisplay').innerText = currentUser.username;
            document.getElementById('accUniqueCode').innerText = currentUser.uniqueCode;

            const linkedSec = document.getElementById('accLinkedSection');
            const unlinkedBox = document.getElementById('accUnlinkedCodeBox');

            if (currentUser.linkedGrowId) {
                linkedSec.style.display = 'block';
                unlinkedBox.style.display = 'none';
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
                linkedSec.style.display = 'none';
                unlinkedBox.style.display = 'block';
            }
        }

        function copyUniqueCode() {
            if (currentUser && currentUser.uniqueCode) {
                navigator.clipboard.writeText(currentUser.uniqueCode);
                showToast('Unique Link Code ' + currentUser.uniqueCode + ' copied to clipboard!', 'success');
            }
        }

        async function handleUnlink() {
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
                    showToast('In-game account unlinked successfully.', 'success');
                }
            } catch (e) {
                showToast('Failed to unlink account.', 'error');
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
            showToast('Logged out successfully.', 'success');
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
            const userTag = (currentUser && currentUser.linkedGrowId) ? ' (Linked: ' + currentUser.linkedGrowId + ')' : '';
            showToast('To buy ' + item + userTag + ', please contact staff on Discord / WhatsApp!', 'success');
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
            showToast('Copied to clipboard!', 'success');
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

        setInterval(fetchServerStatus, 2000);
        fetchServerStatus();

        fetchUserProfile();
        setInterval(fetchUserProfile, 1000);
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
