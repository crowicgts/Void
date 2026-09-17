const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const GTPS_PORT = process.env.GTPS_PORT || 25741;
const GTPS_CLOUD_API = `https://api.gtps.cloud/g-api/${GTPS_PORT}/status`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let serverData = {
    status: "OFFLINE",
    lastHeartbeat: 0,
    port: GTPS_PORT,
    playerCount: 0,
    players: [],
    logs: []
};

let pendingLinks = {};
let verifiedSessions = {};

// Direct inbound push from GTPS Lua
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
    return res.json({ success: true, pendingLinks: Object.values(pendingLinks).filter(p => p.status === 'PENDING') });
});

// Periodic fallback polling from GTPS Cloud Gateway
async function pollGTPSCloud() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);

        const response = await fetch(GTPS_CLOUD_API, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
            const data = await response.json();
            serverData = {
                status: "ONLINE",
                lastHeartbeat: Date.now(),
                port: data.port || GTPS_PORT,
                playerCount: data.playerCount || (data.players ? data.players.length : 0),
                players: data.players || [],
                logs: data.logs || serverData.logs || []
            };
        } else {
            if (Date.now() - serverData.lastHeartbeat > 8000) {
                serverData.status = "OFFLINE";
            }
        }
    } catch (err) {
        if (Date.now() - serverData.lastHeartbeat > 8000) {
            serverData.status = "OFFLINE";
        }
    }
}

setInterval(pollGTPSCloud, 2500);
pollGTPSCloud();

app.get('/api/status', (req, res) => {
    res.json(serverData);
});

// Web Account Link Request
app.post('/api/link-request', (req, res) => {
    const { growId } = req.body;
    if (!growId || growId.trim() === '') {
        return res.status(400).json({ error: 'Please enter a valid in-game name' });
    }

    const cleanName = growId.trim();
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const requestId = 'REQ-' + Date.now();

    pendingLinks[requestId] = {
        id: requestId,
        growId: cleanName,
        code: code,
        status: 'PENDING',
        createdAt: Date.now()
    };

    return res.json({ success: true, requestId, code, growId: cleanName });
});

// Check if in-game accepted the link
app.get('/api/link-status/:requestId', (req, res) => {
    const { requestId } = req.params;
    const item = pendingLinks[requestId];
    if (!item) {
        return res.json({ status: 'EXPIRED' });
    }
    return res.json({ status: item.status, growId: item.growId });
});

// Endpoint called by in-game Lua to verify
app.post('/api/link-verify', (req, res) => {
    const { requestId, code, action } = req.body;
    const item = pendingLinks[requestId];
    if (!item) {
        return res.status(404).json({ error: 'Request not found' });
    }

    if (action === 'ACCEPT' && item.code === code) {
        item.status = 'VERIFIED';
        verifiedSessions[item.growId] = {
            growId: item.growId,
            verifiedAt: Date.now()
        };
        return res.json({ success: true, message: 'Account verified successfully!' });
    } else {
        item.status = 'REJECTED';
        return res.json({ success: true, message: 'Request rejected' });
    }
});

// Public pending list for in-game Lua /accept
app.get('/api/pending-links/:growId', (req, res) => {
    const targetName = req.params.growId.toLowerCase();
    const matches = Object.values(pendingLinks).filter(p => 
        p.status === 'PENDING' && 
        p.growId.toLowerCase() === targetName &&
        (Date.now() - p.createdAt < 300000)
    );
    return res.json({ requests: matches });
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
    <title>VOID Private Server</title>
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

        .shop-card h4 {
            font-size: 19px;
            font-weight: 900;
            color: #ffffff;
            margin-bottom: 6px;
        }

        .shop-card .price {
            font-size: 22px;
            font-weight: 900;
            color: var(--gold-bright);
            margin-bottom: 14px;
        }

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

        .btn-buy:hover {
            box-shadow: 0 0 20px var(--gold-glow);
            filter: brightness(1.1);
        }

        /* In-Game Sync Dialog */
        .auth-input {
            width: 100%;
            background: #050403;
            border: 1px solid var(--gold-border);
            padding: 14px;
            border-radius: 8px;
            color: #ffffff;
            font-size: 16px;
            font-weight: 700;
            margin-bottom: 14px;
            outline: none;
        }

        .auth-input:focus {
            border-color: var(--gold-bright);
            box-shadow: 0 0 15px var(--gold-glow);
        }

        .sync-step-box {
            background: rgba(212, 175, 55, 0.08);
            border: 1px dashed var(--gold-primary);
            border-radius: 10px;
            padding: 18px;
            margin: 16px 0;
            text-align: left;
        }

        .code-display {
            font-size: 32px;
            font-weight: 900;
            letter-spacing: 4px;
            color: var(--gold-bright);
            text-align: center;
            margin: 12px 0;
            text-shadow: 0 0 20px var(--gold-glow);
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
            <button class="auth-status-btn" id="authBtn" onclick="openAuthModal()">
                <span id="authBtnText">LINK ACCOUNT</span>
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
            <div class="val" id="playerCountVal" style="color:var(--gold-bright);">0</div>
        </div>
    </section>

    <!-- IN-GAME SYNC LOGIN MODAL -->
    <div class="portal-modal" id="authModal">
        <div class="portal-box" style="max-width: 520px; text-align: center;">
            <div class="portal-header">
                <h3 id="authModalTitle">IN-GAME ACCOUNT SYNC</h3>
                <button onclick="closeAuthModal()" style="background:transparent; border:none; color:var(--gold-bright); font-size:26px; cursor:pointer;">&times;</button>
            </div>

            <div id="authStep1">
                <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;" id="authDesc">
                    Enter your in-game username to safely connect your character with the web store:
                </p>
                <input type="text" id="targetGrowId" placeholder="Enter In-Game Name..." class="auth-input">
                <button class="btn-buy" onclick="submitLinkRequest()" id="btnStartLink">CONTINUE</button>
            </div>

            <div id="authStep2" style="display:none;">
                <p style="color: var(--text-muted); font-size: 14px;">Your verification code has been generated:</p>
                <div class="code-display" id="displayCode">----</div>
                <div class="sync-step-box">
                    <h5 style="color:var(--gold-bright); font-size:14px; margin-bottom:6px;">HOW TO VERIFY IN-GAME:</h5>
                    <p style="font-size:13px; color:var(--text-muted); line-height:1.5;">
                        1. Open Growtopia & login to your character.<br>
                        2. Type <b>/accept</b> in chat.<br>
                        3. Click <b>[ACCEPT]</b> for Code: <span id="codeSpan" style="color:var(--gold-bright); font-weight:bold;">----</span>.<br>
                        4. This window will automatically verify!
                    </p>
                </div>
                <div style="font-size:13px; color:#10b981; font-weight:bold;" id="pollingStatus">
                    Waiting for in-game /accept confirmation...
                </div>
            </div>

            <div id="authStep3" style="display:none;">
                <div style="font-size:42px; color:#10b981; margin-bottom:10px;">SUCCESS</div>
                <h4 style="font-size:20px; color:#fff; margin-bottom:8px;">Account Verified!</h4>
                <p style="color:var(--text-muted); font-size:14px; margin-bottom:20px;">
                    Logged in as <b id="loggedInGrowId" style="color:var(--gold-bright);"></b>
                </p>
                <button class="btn-buy" onclick="closeAuthModal()">CONTINUE TO STORE</button>
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
        let activeRequestId = null;
        let activePollTimer = null;
        let verifiedUser = localStorage.getItem('voidps_verified_user') || null;

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

        function openAuthModal() {
            if (verifiedUser) {
                document.getElementById('authStep1').style.display = 'none';
                document.getElementById('authStep2').style.display = 'none';
                document.getElementById('authStep3').style.display = 'block';
                document.getElementById('loggedInGrowId').innerText = verifiedUser;
            } else {
                document.getElementById('authStep1').style.display = 'block';
                document.getElementById('authStep2').style.display = 'none';
                document.getElementById('authStep3').style.display = 'none';
            }
            document.getElementById('authModal').style.display = 'flex';
        }

        function closeAuthModal() {
            document.getElementById('authModal').style.display = 'none';
            if (activePollTimer) clearInterval(activePollTimer);
        }

        async function submitLinkRequest() {
            const name = document.getElementById('targetGrowId').value;
            if (!name || name.trim() === '') {
                alert('Please enter your in-game name!');
                return;
            }

            try {
                const res = await fetch('/api/link-request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ growId: name.trim() })
                });
                const data = await res.json();
                if (data.success) {
                    activeRequestId = data.requestId;
                    document.getElementById('displayCode').innerText = data.code;
                    document.getElementById('codeSpan').innerText = data.code;
                    document.getElementById('authStep1').style.display = 'none';
                    document.getElementById('authStep2').style.display = 'block';

                    if (activePollTimer) clearInterval(activePollTimer);
                    activePollTimer = setInterval(pollAuthStatus, 2000);
                }
            } catch (e) {
                alert('Connection error');
            }
        }

        async function pollAuthStatus() {
            if (!activeRequestId) return;
            try {
                const res = await fetch('/api/link-status/' + activeRequestId);
                const data = await res.json();
                if (data.status === 'VERIFIED') {
                    clearInterval(activePollTimer);
                    verifiedUser = data.growId;
                    localStorage.setItem('voidps_verified_user', verifiedUser);
                    document.getElementById('authBtnText').innerText = '👑 ' + verifiedUser;
                    document.getElementById('loggedInGrowId').innerText = verifiedUser;
                    document.getElementById('authStep2').style.display = 'none';
                    document.getElementById('authStep3').style.display = 'block';
                }
            } catch (e) {}
        }

        if (verifiedUser) {
            document.getElementById('authBtnText').innerText = '👑 ' + verifiedUser;
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
            const userTag = verifiedUser ? ' (Linked Character: ' + verifiedUser + ')' : '';
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
