const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ============ GITHUB YEDEKLEME AYARLARI ============
const GITHUB_TOKEN = "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";
const GITHUB_REPO = "4detrail/z0nk";
const GITHUB_BACKUP_FILE = "backup/chat_data.json";

// Veri dosyaları
let users = [];
let rooms = [];
let messages = [];
let userRooms = [];
let userActivity = {};
let userRoles = {}; // Kullanıcı rolleri: { roomCode: { username: role } }
let bannedUsers = {}; // Banlanan kullanıcılar: { roomCode: [usernames] }

// Roller
const ROLES = {
    OWNER: 'owner',      // Kurucu
    MOD: 'mod',          // Moderatör
    MEMBER: 'member'     // Üye
};

// ============ SPAM KORUMASI ============
let lastMessageTime = {};
const MESSAGE_COOLDOWN = 2000;

// ============ ODA SİLME AYARLARI ============
const ROOM_DELETE_SETTINGS = {
    type: 'never', // 'never', 'timeout', 'afk'
    timeoutHours: 24, // 24 saat sonra sil
    afkMinutes: 30 // 30 dakika AFK kalırsa sil
};

// ============ MESAJ SİLME AYARLARI ============
let messageDeleteSettings = {
    enabled: true,
    duration: 24, // saat
    durationType: 'hours'
};

// ============ YEDEKLEME FONKSİYONLARI ============

async function backupToGitHub() {
    try {
        const backupData = {
            users: users,
            rooms: rooms,
            messages: messages,
            userRooms: userRooms,
            userActivity: userActivity,
            userRoles: userRoles,
            bannedUsers: bannedUsers,
            lastBackup: new Date().toISOString()
        };
        
        let sha = null;
        try {
            const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (getRes.ok) {
                const data = await getRes.json();
                sha = data.sha;
            }
        } catch(e) {}
        
        const content = Buffer.from(JSON.stringify(backupData, null, 2)).toString('base64');
        const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                message: `Backup - ${new Date().toISOString()}`,
                content: content,
                sha: sha
            })
        });
        
        if (putRes.ok) {
            console.log(`✅ GitHub yedekleme başarılı - ${new Date().toLocaleTimeString()}`);
        }
    } catch(e) {
        console.error("GitHub yedekleme hatası:", e.message);
    }
}

async function restoreFromGitHub() {
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (res.ok) {
            const data = await res.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            const backupData = JSON.parse(content);
            
            users = backupData.users || [];
            rooms = backupData.rooms || [];
            messages = backupData.messages || [];
            userRooms = backupData.userRooms || [];
            userActivity = backupData.userActivity || {};
            userRoles = backupData.userRoles || {};
            bannedUsers = backupData.bannedUsers || {};
            
            console.log(`✅ GitHub'dan geri yükleme başarılı - ${users.length} kullanıcı, ${rooms.length} oda`);
            saveData();
            return true;
        }
    } catch(e) {
        console.log("GitHub geri yükleme yapılamadı (ilk çalıştırma olabilir)");
    }
    return false;
}

// ============ DOSYA İŞLEMLERİ ============

const loadData = () => {
    try {
        if(fs.existsSync('users.json')) users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        if(fs.existsSync('rooms.json')) rooms = JSON.parse(fs.readFileSync('rooms.json', 'utf8'));
        if(fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if(fs.existsSync('userRooms.json')) userRooms = JSON.parse(fs.readFileSync('userRooms.json', 'utf8'));
        if(fs.existsSync('userActivity.json')) userActivity = JSON.parse(fs.readFileSync('userActivity.json', 'utf8'));
        if(fs.existsSync('userRoles.json')) userRoles = JSON.parse(fs.readFileSync('userRoles.json', 'utf8'));
        if(fs.existsSync('bannedUsers.json')) bannedUsers = JSON.parse(fs.readFileSync('bannedUsers.json', 'utf8'));
    } catch(e) {}
};

const saveData = () => {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
    fs.writeFileSync('rooms.json', JSON.stringify(rooms, null, 2));
    fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2));
    fs.writeFileSync('userRooms.json', JSON.stringify(userRooms, null, 2));
    fs.writeFileSync('userActivity.json', JSON.stringify(userActivity, null, 2));
    fs.writeFileSync('userRoles.json', JSON.stringify(userRoles, null, 2));
    fs.writeFileSync('bannedUsers.json', JSON.stringify(bannedUsers, null, 2));
};

// ============ OTOMATİK MESAJ SİLME (Ayarlanabilir) ============
setInterval(() => {
    if (!messageDeleteSettings.enabled) return;
    
    const now = new Date();
    let deleteBefore = new Date(now);
    
    if (messageDeleteSettings.durationType === 'hours') {
        deleteBefore.setHours(now.getHours() - messageDeleteSettings.duration);
    } else if (messageDeleteSettings.durationType === 'minutes') {
        deleteBefore.setMinutes(now.getMinutes() - messageDeleteSettings.duration);
    } else if (messageDeleteSettings.durationType === 'days') {
        deleteBefore.setDate(now.getDate() - messageDeleteSettings.duration);
    }
    
    const beforeCount = messages.length;
    messages = messages.filter(msg => new Date(msg.timestamp) > deleteBefore);
    
    if (messages.length !== beforeCount) {
        console.log(`🗑️ ${beforeCount - messages.length} eski mesaj silindi`);
        saveData();
        backupToGitHub();
    }
}, 60 * 1000);

// ============ OTOMATİK ODA SİLME ============
setInterval(() => {
    if (ROOM_DELETE_SETTINGS.type === 'never') return;
    
    const now = Date.now();
    for (let i = rooms.length - 1; i >= 0; i--) {
        const room = rooms[i];
        let shouldDelete = false;
        
        if (ROOM_DELETE_SETTINGS.type === 'timeout') {
            const createdTime = new Date(room.created_at).getTime();
            const hoursPassed = (now - createdTime) / (1000 * 60 * 60);
            if (hoursPassed >= ROOM_DELETE_SETTINGS.timeoutHours) {
                shouldDelete = true;
            }
        } else if (ROOM_DELETE_SETTINGS.type === 'afk') {
            const lastActiveUsers = room.users.filter(u => userActivity[u] && (now - userActivity[u] < ROOM_DELETE_SETTINGS.afkMinutes * 60 * 1000));
            if (lastActiveUsers.length === 0) {
                shouldDelete = true;
            }
        }
        
        if (shouldDelete) {
            // Odayı ve mesajlarını sil
            messages = messages.filter(m => m.room_code !== room.room_code);
            for (const user of room.users) {
                const urIdx = userRooms.findIndex(u => u.username === user && u.current_room === room.room_code);
                if (urIdx !== -1) userRooms.splice(urIdx, 1);
            }
            if (userRoles[room.room_code]) delete userRoles[room.room_code];
            if (bannedUsers[room.room_code]) delete bannedUsers[room.room_code];
            rooms.splice(i, 1);
            console.log(`🗑️ Oda ${room.room_code} otomatik silindi`);
        }
    }
    saveData();
}, 60 * 1000);

// ============ AFK kontrolü (10 dakika) ============
setInterval(() => {
    const now = Date.now();
    for (const [username, lastActive] of Object.entries(userActivity)) {
        if (now - lastActive > 10 * 60 * 1000) {
            const idx = userRooms.findIndex(u => u.username === username);
            if (idx !== -1) {
                const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
                if (room && room.users) {
                    const userIdx = room.users.indexOf(username);
                    if (userIdx !== -1) room.users.splice(userIdx, 1);
                }
                userRooms.splice(idx, 1);
                console.log(`🗑️ ${username} AFK olduğu için odadan atıldı`);
            }
            delete userActivity[username];
            saveData();
        }
    }
}, 60 * 1000);

// ============ Oda kodu üretici ============
function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '#';
    for(let i = 0; i < 2; i++) code += letters[Math.floor(Math.random() * letters.length)];
    for(let i = 0; i < 3; i++) code += numbers[Math.floor(Math.random() * numbers.length)];
    return code;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ KULLANICILAR ============

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    
    if(users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı var!' });
    
    const hashed = await bcrypt.hash(password, 10);
    users.push({ username, password: hashed, created_at: new Date().toISOString() });
    saveData();
    backupToGitHub();
    res.json({ success: true });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if(!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı!' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if(!validPass) return res.status(401).json({ error: 'Hatalı şifre!' });
    
    const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
    userActivity[username] = Date.now();
    saveData();
    res.json({ token, username });
});

app.post('/update_activity', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ ROL FONKSİYONLARI ============

function getUserRole(roomCode, username) {
    if (!userRoles[roomCode]) userRoles[roomCode] = {};
    return userRoles[roomCode][username] || ROLES.MEMBER;
}

function setUserRole(roomCode, username, role) {
    if (!userRoles[roomCode]) userRoles[roomCode] = {};
    userRoles[roomCode][username] = role;
    saveData();
}

function isOwner(roomCode, username) {
    const room = rooms.find(r => r.room_code === roomCode);
    return room && room.created_by === username;
}

function canModerate(roomCode, username) {
    const role = getUserRole(roomCode, username);
    return role === ROLES.OWNER || role === ROLES.MOD;
}

// ============ ODALAR ============

app.post('/create_room', async (req, res) => {
    const { username, room_name, room_password, is_private, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let room_code;
        do { room_code = generateRoomCode(); } while(rooms.find(r => r.room_code === room_code));
        
        const hashedPassword = room_password ? await bcrypt.hash(room_password, 10) : null;
        
        rooms.push({ 
            room_code, 
            room_name, 
            room_password: hashedPassword,
            is_private: is_private || false,
            created_by: username, 
            created_at: new Date().toISOString(),
            users: [username]
        });
        
        // Kurucuyu owner yap
        if (!userRoles[room_code]) userRoles[room_code] = {};
        userRoles[room_code][username] = ROLES.OWNER;
        
        saveData();
        backupToGitHub();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/join_room', async (req, res) => {
    const { username, room_code, room_password, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        // Ban kontrolü
        if (bannedUsers[room_code] && bannedUsers[room_code].includes(username)) {
            return res.status(403).json({ error: 'Bu odadan banlandınız!' });
        }
        
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        if (room.room_password) {
            if (!room_password) return res.status(401).json({ error: 'Bu oda şifreli! Şifre girin!' });
            const valid = await bcrypt.compare(room_password, room.room_password);
            if (!valid) return res.status(401).json({ error: 'Oda şifresi hatalı!' });
        }
        
        const idx = userRooms.findIndex(u => u.username === username);
        if(idx !== -1) userRooms[idx].current_room = room_code;
        else userRooms.push({ username, current_room: room_code });
        
        if (!room.users.includes(username)) room.users.push(username);
        
        // Yeni kullanıcıya member rolü ver
        if (!userRoles[room_code]) userRoles[room_code] = {};
        if (!userRoles[room_code][username]) userRoles[room_code][username] = ROLES.MEMBER;
        
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Rol verme (sadece owner)
app.post('/set_role', (req, res) => {
    const { username, targetUsername, role, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        if (!isOwner(room_code, username)) {
            return res.status(403).json({ error: 'Sadece oda kurucusu rol verebilir!' });
        }
        
        if (!Object.values(ROLES).includes(role)) {
            return res.status(400).json({ error: 'Geçersiz rol!' });
        }
        
        setUserRole(room_code, targetUsername, role);
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Kullanıcı banlama (owner veya mod)
app.post('/ban_user', (req, res) => {
    const { username, targetUsername, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        if (!canModerate(room_code, username)) {
            return res.status(403).json({ error: 'Yetkiniz yok!' });
        }
        
        if (!bannedUsers[room_code]) bannedUsers[room_code] = [];
        if (!bannedUsers[room_code].includes(targetUsername)) {
            bannedUsers[room_code].push(targetUsername);
            
            // Kullanıcıyı odadan çıkar
            const urIdx = userRooms.findIndex(u => u.username === targetUsername && u.current_room === room_code);
            if (urIdx !== -1) {
                const room = rooms.find(r => r.room_code === room_code);
                if (room) {
                    const userIdx = room.users.indexOf(targetUsername);
                    if (userIdx !== -1) room.users.splice(userIdx, 1);
                }
                userRooms.splice(urIdx, 1);
            }
        }
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Kullanıcıyı ban'dan kaldır
app.post('/unban_user', (req, res) => {
    const { username, targetUsername, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        if (!canModerate(room_code, username)) {
            return res.status(403).json({ error: 'Yetkiniz yok!' });
        }
        
        if (bannedUsers[room_code]) {
            const idx = bannedUsers[room_code].indexOf(targetUsername);
            if (idx !== -1) bannedUsers[room_code].splice(idx, 1);
        }
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/delete_room', (req, res) => {
    const { username, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        if (room.created_by !== username && getUserRole(room_code, username) !== ROLES.OWNER) {
            return res.status(403).json({ error: 'Bu odayı sadece oluşturan kişi silebilir!' });
        }
        
        const deletedMsgCount = messages.filter(m => m.room_code === room_code).length;
        messages = messages.filter(m => m.room_code !== room_code);
        
        for (const user of room.users) {
            const urIdx = userRooms.findIndex(u => u.username === user && u.current_room === room_code);
            if (urIdx !== -1) userRooms.splice(urIdx, 1);
        }
        
        if (userRoles[room_code]) delete userRoles[room_code];
        if (bannedUsers[room_code]) delete bannedUsers[room_code];
        
        const roomIdx = rooms.findIndex(r => r.room_code === room_code);
        rooms.splice(roomIdx, 1);
        
        console.log(`🗑️ Oda ${room_code} silindi, ${deletedMsgCount} mesaj temizlendi`);
        saveData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/current_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        res.json({ room_code: ur ? ur.current_room : null });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/leave_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        const urIdx = userRooms.findIndex(u => u.username === username);
        if (urIdx !== -1) {
            const roomCode = userRooms[urIdx].current_room;
            const room = rooms.find(r => r.room_code === roomCode);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(urIdx, 1);
        }
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/list_rooms', (req, res) => {
    const { token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const publicRooms = rooms
            .filter(r => !r.is_private)
            .map(r => ({
                room_code: r.room_code,
                room_name: r.room_name,
                created_by: r.created_by,
                is_locked: !!r.room_password,
                is_private: r.is_private || false,
                users_count: r.users ? r.users.filter(u => userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000)).length : 0,
                total_users: r.users ? r.users.length : 0,
                message_count: messages.filter(m => m.room_code === r.room_code).length
            }));
        res.json(publicRooms);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/room_users', (req, res) => {
    const { room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.json([]);
        
        const usersWithRoles = room.users.map(u => ({
            username: u,
            role: getUserRole(room_code, u),
            isActive: userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000)
        }));
        
        res.json(usersWithRoles);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ MESAJ AYARLARI ============

app.post('/get_message_settings', (req, res) => {
    res.json(messageDeleteSettings);
});

app.post('/set_message_settings', (req, res) => {
    const { token, enabled, duration, durationType } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        if (enabled !== undefined) messageDeleteSettings.enabled = enabled;
        if (duration !== undefined) messageDeleteSettings.duration = duration;
        if (durationType !== undefined) messageDeleteSettings.durationType = durationType;
        saveData();
        res.json({ success: true, settings: messageDeleteSettings });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ MESAJLAR ============

app.post('/send', (req, res) => {
    const { from, message, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        const now = Date.now();
        const lastTime = lastMessageTime[from] || 0;
        if (now - lastTime < MESSAGE_COOLDOWN) {
            return res.status(429).json({ 
                error: `Lütfen ${Math.ceil((MESSAGE_COOLDOWN - (now - lastTime)) / 1000)} saniye bekleyin!`,
                waitTime: MESSAGE_COOLDOWN - (now - lastTime)
            });
        }
        
        const ur = userRooms.find(u => u.username === from);
        if(!ur || !ur.current_room) return res.status(400).json({ error: 'Önce bir odaya katılın!' });
        
        const room = rooms.find(r => r.room_code === ur.current_room);
        if (!room) return res.status(400).json({ error: 'Oda silinmiş!' });
        
        // Ban kontrolü
        if (bannedUsers[ur.current_room] && bannedUsers[ur.current_room].includes(from)) {
            return res.status(403).json({ error: 'Bu odadan banlandınız!' });
        }
        
        lastMessageTime[from] = now;
        userActivity[from] = Date.now();
        
        messages.push({ 
            room_code: ur.current_room, 
            from_user: from, 
            message, 
            timestamp: new Date().toISOString(),
            role: getUserRole(ur.current_room, from)
        });
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        if(!ur || !ur.current_room) return res.json([]);
        
        userActivity[username] = Date.now();
        
        const roomMessages = messages
            .filter(m => m.room_code === ur.current_room)
            .slice(-200);
        
        res.json(roomMessages);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/logout', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const idx = userRooms.findIndex(u => u.username === username);
        if (idx !== -1) {
            const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(idx, 1);
        }
        delete userActivity[username];
        delete lastMessageTime[username];
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ SUNUCU BAŞLAT ============
const PORT = process.env.PORT || 3000;

restoreFromGitHub().then(() => {
    loadData();
    console.log(`\n🔥 HEXAHACK IAIM CHAT SİSTEMİ AKTİF!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`⏰ Mesaj silme ayarı: ${messageDeleteSettings.enabled ? messageDeleteSettings.duration + ' ' + messageDeleteSettings.durationType : 'Kapalı'}`);
    console.log(`🗑️ Oda silme ayarı: ${ROOM_DELETE_SETTINGS.type}`);
    console.log(`💾 GitHub yedekleme aktif - Her 5 dakikada bir yedekleniyor`);
    console.log(`🛡️ Spam koruması aktif - ${MESSAGE_COOLDOWN/1000} saniye`);
    console.log(`👑 Rol sistemi aktif - Owner/Mod/Member`);
});

app.listen(PORT, '0.0.0.0', () => {}); 
