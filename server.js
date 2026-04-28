const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ============ GITHUB YEDEKLEME AYARLARI ============
const GITHUB_TOKEN = "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";
const GITHUB_REPO = "4detrail/z0nk";
const GITHUB_BACKUP_FILES = [
    { name: "servers.json", path: "backup/servers.json" },
    { name: "channels.json", path: "backup/channels.json" },
    { name: "messages.json", path: "backup/messages.json" },
    { name: "users.json", path: "backup/users.json" },
    { name: "user_sessions.json", path: "backup/user_sessions.json" },
    { name: "user_activity.json", path: "backup/user_activity.json" }
];

// ============ VERİ DOSYALARI ============
let users = [];
let servers = [];
let channels = [];
let messages = [];
let userSessions = []; // { username, serverId, channelId }
let userActivity = {}; // { username: timestamp }

// Şifreleme anahtarı (32 byte)
const ENCRYPTION_KEY = crypto.scryptSync('iaim-secure-key-2024', 'salt', 32);
const IV_LENGTH = 16;

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Roller
const ROLES = { OWNER: 'owner', MOD: 'mod', MEMBER: 'member' };

// Spam koruması
let lastMessageTime = {};
const MESSAGE_COOLDOWN = 2000;

// ============ OTOMATİK SİLME KONTROLÜ ============
setInterval(() => {
    const now = Date.now();
    for (let i = 0; i < servers.length; i++) {
        const server = servers[i];
        if (server.deleteAfter && server.deleteAfter !== 'never') {
            let deleteTime = 0;
            if (server.deleteAfter.endsWith('h')) deleteTime = parseInt(server.deleteAfter) * 3600000;
            else if (server.deleteAfter.endsWith('d')) deleteTime = parseInt(server.deleteAfter) * 86400000;
            else if (server.deleteAfter.endsWith('w')) deleteTime = parseInt(server.deleteAfter) * 604800000;
            
            if (deleteTime > 0 && (now - new Date(server.createdAt).getTime() >= deleteTime)) {
                // Sunucuyu sil
                const serverId = server.id;
                servers.splice(i, 1);
                channels = channels.filter(c => c.serverId !== serverId);
                messages = messages.filter(m => m.serverId !== serverId);
                userSessions = userSessions.filter(s => s.serverId !== serverId);
                console.log(`🗑️ Otomatik silme: Sunucu ${server.name} (${serverId}) silindi.`);
                i--;
                saveAllData();
                backupToGitHub();
            }
        }
    }
}, 60 * 1000); // Her dakika kontrol et

// ============ AFK KONTROLÜ ============
setInterval(() => {
    const now = Date.now();
    for (const [username, lastActive] of Object.entries(userActivity)) {
        if (now - lastActive > 10 * 60 * 1000) {
            const session = userSessions.find(s => s.username === username);
            if (session) {
                const server = servers.find(s => s.id === session.serverId);
                if (server) {
                    server.members = server.members.filter(m => m.username !== username);
                }
                const idx = userSessions.findIndex(s => s.username === username);
                if (idx !== -1) userSessions.splice(idx, 1);
                console.log(`🗑️ ${username} AFK olduğu için sunucudan atıldı`);
            }
            delete userActivity[username];
        }
    }
    saveAllData();
}, 60 * 1000);

// ============ YEDEKLEME FONKSİYONLARI ============
async function backupToGitHub() {
    try {
        const backupData = {
            users, servers, channels, messages, userSessions, userActivity,
            lastBackup: new Date().toISOString()
        };
        
        for (const file of GITHUB_BACKUP_FILES) {
            let content = '';
            if (file.name === 'users.json') content = JSON.stringify(users, null, 2);
            else if (file.name === 'servers.json') content = JSON.stringify(servers, null, 2);
            else if (file.name === 'channels.json') content = JSON.stringify(channels, null, 2);
            else if (file.name === 'messages.json') content = JSON.stringify(messages, null, 2);
            else if (file.name === 'user_sessions.json') content = JSON.stringify(userSessions, null, 2);
            else if (file.name === 'user_activity.json') content = JSON.stringify(userActivity, null, 2);
            
            let sha = null;
            try {
                const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file.path}`, {
                    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
                });
                if (getRes.ok) {
                    const data = await getRes.json();
                    sha = data.sha;
                }
            } catch(e) {}
            
            const encoded = Buffer.from(content).toString('base64');
            await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file.path}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `Backup ${file.name}`, content: encoded, sha })
            });
        }
        console.log(`✅ GitHub yedekleme başarılı - ${new Date().toLocaleTimeString()}`);
    } catch(e) { console.error("GitHub yedekleme hatası:", e.message); }
}

async function restoreFromGitHub() {
    try {
        for (const file of GITHUB_BACKUP_FILES) {
            const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file.path}`, {
                headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
            });
            if (res.ok) {
                const data = await res.json();
                const content = Buffer.from(data.content, 'base64').toString('utf8');
                if (file.name === 'users.json') users = JSON.parse(content);
                else if (file.name === 'servers.json') servers = JSON.parse(content);
                else if (file.name === 'channels.json') channels = JSON.parse(content);
                else if (file.name === 'messages.json') messages = JSON.parse(content);
                else if (file.name === 'user_sessions.json') userSessions = JSON.parse(content);
                else if (file.name === 'user_activity.json') userActivity = JSON.parse(content);
            }
        }
        console.log(`✅ GitHub'dan geri yükleme başarılı - ${users.length} kullanıcı, ${servers.length} sunucu`);
        return true;
    } catch(e) { console.log("GitHub geri yükleme yapılamadı (ilk çalıştırma)"); return false; }
}

function saveAllData() {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
    fs.writeFileSync('servers.json', JSON.stringify(servers, null, 2));
    fs.writeFileSync('channels.json', JSON.stringify(channels, null, 2));
    fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2));
    fs.writeFileSync('user_sessions.json', JSON.stringify(userSessions, null, 2));
    fs.writeFileSync('user_activity.json', JSON.stringify(userActivity, null, 2));
}

function loadAllData() {
    try {
        if(fs.existsSync('users.json')) users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        if(fs.existsSync('servers.json')) servers = JSON.parse(fs.readFileSync('servers.json', 'utf8'));
        if(fs.existsSync('channels.json')) channels = JSON.parse(fs.readFileSync('channels.json', 'utf8'));
        if(fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if(fs.existsSync('user_sessions.json')) userSessions = JSON.parse(fs.readFileSync('user_sessions.json', 'utf8'));
        if(fs.existsSync('user_activity.json')) userActivity = JSON.parse(fs.readFileSync('user_activity.json', 'utf8'));
    } catch(e) {}
}

// ============ YARDIMCI FONKSİYONLAR ============
function generateServerCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '#';
    for(let i = 0; i < 2; i++) code += letters[Math.floor(Math.random() * letters.length)];
    for(let i = 0; i < 3; i++) code += numbers[Math.floor(Math.random() * numbers.length)];
    return code;
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }

function getUserRole(serverId, username) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return null;
    const member = server.members.find(m => m.username === username);
    return member ? member.role : null;
}

function isOwner(serverId, username) {
    const server = servers.find(s => s.id === serverId);
    return server && server.owner === username;
}

function canModerate(serverId, username) {
    const role = getUserRole(serverId, username);
    return role === ROLES.OWNER || role === ROLES.MOD;
}

// ============ API ENDPOINTLERİ ============

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Kullanıcı işlemleri
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı var!' });
    const hashed = await bcrypt.hash(password, 10);
    users.push({ username, password: hashed, createdAt: new Date().toISOString() });
    saveAllData();
    backupToGitHub();
    res.json({ success: true });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı!' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Hatalı şifre!' });
    const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
    userActivity[username] = Date.now();
    saveAllData();
    res.json({ token, username });
});

app.post('/update_activity', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        userActivity[username] = Date.now();
        saveAllData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Sunucu işlemleri
app.post('/create_server', async (req, res) => {
    const { username, name, password, isPrivate, deleteAfter, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let serverCode;
        do { serverCode = generateServerCode(); } while(servers.find(s => s.code === serverCode));
        
        const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
        const serverId = generateId();
        const newServer = {
            id: serverId,
            code: serverCode,
            name: name,
            password: hashedPassword,
            isPrivate: isPrivate || false,
            owner: username,
            createdAt: new Date().toISOString(),
            deleteAfter: deleteAfter || 'never',
            members: [{ username, role: ROLES.OWNER }]
        };
        servers.push(newServer);
        
        // Varsayılan bir kanal oluştur ("genel")
        channels.push({ id: generateId(), serverId, name: "genel", createdAt: new Date().toISOString() });
        
        saveAllData();
        backupToGitHub();
        res.json({ success: true, serverId, serverCode });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/join_server', async (req, res) => {
    const { username, code, password, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const server = servers.find(s => s.code === code);
        if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı!' });
        
        if (server.password) {
            if (!password) return res.status(401).json({ error: 'Sunucu şifreli!' });
            const valid = await bcrypt.compare(password, server.password);
            if (!valid) return res.status(401).json({ error: 'Şifre hatalı!' });
        }
        
        if (server.members.some(m => m.username === username)) {
            return res.status(400).json({ error: 'Zaten bu sunucudasınız!' });
        }
        
        server.members.push({ username, role: ROLES.MEMBER });
        
        // Varsayılan kanalı seç
        const defaultChannel = channels.find(c => c.serverId === server.id);
        const session = userSessions.find(s => s.username === username);
        if (session) {
            session.serverId = server.id;
            session.channelId = defaultChannel ? defaultChannel.id : null;
        } else {
            userSessions.push({ username, serverId: server.id, channelId: defaultChannel ? defaultChannel.id : null });
        }
        
        saveAllData();
        backupToGitHub();
        res.json({ success: true, serverId: server.id });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/leave_server', (req, res) => {
    const { username, serverId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const server = servers.find(s => s.id === serverId);
        if (server) {
            server.members = server.members.filter(m => m.username !== username);
            const sessionIdx = userSessions.findIndex(s => s.username === username && s.serverId === serverId);
            if (sessionIdx !== -1) userSessions.splice(sessionIdx, 1);
            saveAllData();
            backupToGitHub();
        }
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/delete_server', (req, res) => {
    const { username, serverId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const server = servers.find(s => s.id === serverId);
        if (!server) return res.status(404).json({ error: 'Sunucu yok!' });
        if (server.owner !== username) return res.status(403).json({ error: 'Sadece kurucu silebilir!' });
        
        const idx = servers.findIndex(s => s.id === serverId);
        servers.splice(idx, 1);
        channels = channels.filter(c => c.serverId !== serverId);
        messages = messages.filter(m => m.serverId !== serverId);
        userSessions = userSessions.filter(s => s.serverId !== serverId);
        saveAllData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/list_servers', (req, res) => {
    const { token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const publicServers = servers
            .filter(s => !s.isPrivate)
            .map(s => ({
                id: s.id,
                code: s.code,
                name: s.name,
                isLocked: !!s.password,
                memberCount: s.members.length,
                owner: s.owner
            }));
        res.json(publicServers);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/my_servers', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const myServers = servers.filter(s => s.members.some(m => m.username === username))
            .map(s => ({ id: s.id, code: s.code, name: s.name, role: getUserRole(s.id, username), owner: s.owner }));
        res.json(myServers);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/current_session', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const session = userSessions.find(s => s.username === username);
        res.json({ serverId: session?.serverId, channelId: session?.channelId });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/set_channel', (req, res) => {
    const { username, serverId, channelId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const session = userSessions.find(s => s.username === username);
        if (session) {
            session.serverId = serverId;
            session.channelId = channelId;
        } else {
            userSessions.push({ username, serverId, channelId });
        }
        userActivity[username] = Date.now();
        saveAllData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Kanal işlemleri
app.post('/create_channel', (req, res) => {
    const { username, serverId, channelName, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const role = getUserRole(serverId, username);
        if (role !== ROLES.OWNER && role !== ROLES.MOD) {
            return res.status(403).json({ error: 'Kanal oluşturmak için yetkiniz yok!' });
        }
        const newChannel = { id: generateId(), serverId, name: channelName, createdAt: new Date().toISOString() };
        channels.push(newChannel);
        saveAllData();
        backupToGitHub();
        res.json({ success: true, channel: newChannel });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/delete_channel', (req, res) => {
    const { username, channelId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const channel = channels.find(c => c.id === channelId);
        if (!channel) return res.status(404).json({ error: 'Kanal yok!' });
        const role = getUserRole(channel.serverId, username);
        if (role !== ROLES.OWNER && role !== ROLES.MOD) {
            return res.status(403).json({ error: 'Yetkiniz yok!' });
        }
        channels = channels.filter(c => c.id !== channelId);
        messages = messages.filter(m => m.channelId !== channelId);
        saveAllData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/server_channels', (req, res) => {
    const { serverId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const serverChannels = channels.filter(c => c.serverId === serverId);
        res.json(serverChannels);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Mesaj işlemleri (şifreli)
app.post('/send_message', (req, res) => {
    const { from, channelId, message, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const now = Date.now();
        if (lastMessageTime[from] && now - lastMessageTime[from] < MESSAGE_COOLDOWN) {
            return res.status(429).json({ error: 'Çok hızlı mesaj gönderiyorsunuz!' });
        }
        
        const session = userSessions.find(s => s.username === from);
        if (!session || !session.serverId || !session.channelId) {
            return res.status(400).json({ error: 'Önce bir kanal seçin!' });
        }
        
        const channel = channels.find(c => c.id === channelId);
        if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı!' });
        
        const encryptedMsg = encrypt(message);
        messages.push({
            id: generateId(),
            serverId: session.serverId,
            channelId,
            from,
            content: encryptedMsg,
            timestamp: new Date().toISOString()
        });
        
        lastMessageTime[from] = now;
        userActivity[from] = now;
        saveAllData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/get_messages', (req, res) => {
    const { channelId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const channelMessages = messages
            .filter(m => m.channelId === channelId)
            .slice(-200)
            .map(m => ({
                id: m.id,
                from: m.from,
                content: decrypt(m.content),
                timestamp: m.timestamp
            }));
        res.json(channelMessages);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/delete_message', (req, res) => {
    const { username, messageId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const msg = messages.find(m => m.id === messageId);
        if (!msg) return res.status(404).json({ error: 'Mesaj yok!' });
        const role = getUserRole(msg.serverId, username);
        if (role !== ROLES.OWNER && role !== ROLES.MOD && msg.from !== username) {
            return res.status(403).json({ error: 'Bu mesajı silme yetkiniz yok!' });
        }
        messages = messages.filter(m => m.id !== messageId);
        saveAllData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Rol işlemleri
app.post('/set_role', (req, res) => {
    const { username, targetUsername, serverId, role, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        if (!isOwner(serverId, username)) return res.status(403).json({ error: 'Sadece kurucu rol atayabilir!' });
        if (!Object.values(ROLES).includes(role)) return res.status(400).json({ error: 'Geçersiz rol!' });
        
        const server = servers.find(s => s.id === serverId);
        const member = server.members.find(m => m.username === targetUsername);
        if (member) member.role = role;
        saveAllData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/ban_user', (req, res) => {
    const { username, targetUsername, serverId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        if (!canModerate(serverId, username)) return res.status(403).json({ error: 'Yetkiniz yok!' });
        
        const server = servers.find(s => s.id === serverId);
        server.members = server.members.filter(m => m.username !== targetUsername);
        const session = userSessions.find(s => s.username === targetUsername && s.serverId === serverId);
        if (session) userSessions = userSessions.filter(s => s !== session);
        saveAllData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/server_members', (req, res) => {
    const { serverId, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const server = servers.find(s => s.id === serverId);
        if (!server) return res.json([]);
        res.json(server.members);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Mesaj silme ayarları (genel)
let messageAutoDelete = { enabled: false, hours: 24 };
app.post('/get_message_auto_delete', (req, res) => res.json(messageAutoDelete));
app.post('/set_message_auto_delete', (req, res) => {
    const { token, enabled, hours } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        messageAutoDelete = { enabled, hours: hours || 24 };
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

setInterval(() => {
    if (messageAutoDelete.enabled) {
        const limit = new Date(Date.now() - messageAutoDelete.hours * 3600000);
        messages = messages.filter(m => new Date(m.timestamp) > limit);
        saveAllData();
    }
}, 3600000);

app.post('/logout', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        userSessions = userSessions.filter(s => s.username !== username);
        delete userActivity[username];
        saveAllData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ SUNUCU BAŞLAT ============
const PORT = process.env.PORT || 3000;

restoreFromGitHub().then(() => {
    loadAllData();
    console.log(`\n🔥 IAIM SECURE v8.0 | SUNUCU + KANAL SİSTEMİ AKTİF`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🔐 Şifreleme: AES-256-CBC aktif`);
    console.log(`💾 GitHub yedekleme: Her 10 dakikada bir`);
    console.log(`🛡️ Rol sistemi: Owner / Mod / Member`);
    console.log(`🗑️ Otomatik silme: Sunucu bazlı ayarlanabilir`);
});

app.listen(PORT, '0.0.0.0', () => {});
