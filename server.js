require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');
const Groq = require("groq-sdk");
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(cors({
    origin: ["https://fluxion-fc-auction.vercel.app/auction.html", "http://localhost:3000"], // Your Community site URL
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-api-key"] // This allows the security key to pass through
}));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Connected to MongoDB"));

// --- BREVO CONFIG ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        // Accept both .mp3 and the standard audio/mpeg type
        if (file.mimetype === "audio/mpeg" || file.mimetype === "audio/mp3" || file.originalname.endsWith('.mp3')) {
            cb(null, true);
        } else {
            cb(new Error("Only .mp3 files are allowed!"), false);
        }
    }
});

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: { type: String },
    role: { type: String, default: 'visitor' }, // visitor, captain, admin
    isVerified: { type: Boolean, default: false },
    otp: String,
    otpExpires: Date
});

const playerSchema = new mongoose.Schema({
    name: String, 
    strength: Number, 
    cardType: String, 
    baseValue: Number,
    phone: String,     // String avoids numeric precision/overflow issues with country codes
    ranking: Number,   // Stores the division/global rank
    imageUrl: String,
    status: { type: String, default: 'Available' }, 
    soldTo: { type: String, default: '-' }
});
const teamSchema = new mongoose.Schema({ 
    name: String, 
    budget: Number,
    initialBudget: Number,
    maxCapacity: { type: Number, default: 10 }, // Default to 15
    logoUrl: { type: String, default: "" }
});

const chatSchema = new mongoose.Schema({ 
    sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } 
});

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);
// 1. Define the History Schema (If not already added)
const historySchema = new mongoose.Schema({
    playerName: String,
    price: Number,
    timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

// 2. THE SAFETY SYNC FUNCTION (Prevents data loss)
async function syncPastSalesToGraph() {
    console.log("🔍 Checking for unsynced past sales...");
    const soldPlayers = await Player.find({ status: 'Sold' });
    
    for (let p of soldPlayers) {
        // Extract price from "Team Name (150M)" format using Regex
        const priceMatch = p.soldTo.match(/\((\d+)M\)/);
        const priceValue = priceMatch ? parseInt(priceMatch[1]) : 0;

        // Check if this player is already in History to avoid duplicates
        const alreadyInHistory = await History.findOne({ playerName: p.name });
        
        if (!alreadyInHistory && priceValue > 0) {
            await History.create({ 
                playerName: p.name, 
                price: priceValue,
                timestamp: new Date() // Approximate time
            });
            console.log(`✅ Recovered Graph Data for: ${p.name}`);
        }
    }
    console.log("📊 Graph History is now fully synced with Database.");
}

// Run the sync every time the server starts
syncPastSalesToGraph();

// --- HARDCODED CREDENTIALS (As requested) ---


// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    sendSmtpEmail.subject = `🔑 ${otp} is your NEXUS LEGENDS Access Code`;
    
    sendSmtpEmail.htmlContent = `
        <div style="font-family: Arial, sans-serif; background-color: #0a0f16; color: #ffffff; padding: 40px; text-align: center; border-radius: 20px;">
            <h1 style="color: #00e5ff; margin-bottom: 10px;">NEXUS LEGENDS</h1>
            <p style="color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 2px;">Identity Verification</p>
            <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;">
            <p style="font-size: 16px;">Use the following code to access the Auction Arena:</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #eaff00;">${otp}</span>
            </div>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">This code will expire in 10 minutes. If you did not request this, please ignore this email.</p>
        </div>
    `;
    
    sendSmtpEmail.sender = { "name": "NEXUS LEGENDS ARENA", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- AUTOMATIC TEAM SEEDING ---



// Add this temporary seeding logic at the bottom of server.js
// --- FORCE RESET MASTER ADMIN ---
async function createMasterAdmin() {
    const adminEmail = "sarkaranubhav48@gmail.com";
    const hashedPassword = await bcrypt.hash("admin123", 10);
    
    // findOneAndUpdate with upsert: true will create it if missing OR update if exists
    await User.findOneAndUpdate(
        { email: adminEmail },
        {
            name: "Nexus Master Admin",
            email: adminEmail,
            password: hashedPassword,
            role: "admin",
            isVerified: true
        },
        { upsert: true, new: true }
    );
    console.log("👑 Master Admin Account Synced (Pass: admin123)");
}
createMasterAdmin();

// --- HTTP ROUTES ---
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); 
        await Team.insertMany(teamList);
        res.send("✅ Teams successfully reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/fix-budgets', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 2000 } });
        res.send("✅ All budgets reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});
// --- ADD THIS TO THE TOP OF server.js (If not already there) ---
app.use(express.json()); 

// --- ADD THIS ROUTE ABOVE io.on('connection') ---
app.post('/api/sync/verify-captain', async (req, res) => {
    try {
        const { email, password, selectedTeam } = req.body;
        const cleanEmail = email.trim().toLowerCase();

        // 1. Find user (Image 2 confirms role is 'captain')
        const user = await User.findOne({ email: cleanEmail, role: 'captain' });
        
        if (!user) {
            return res.status(401).json({ success: false, message: "Email not found in Auction DB" });
        }

        // 2. Check Team Match (Image 2 confirms User.name is the Team Name)
        if (user.name !== selectedTeam) {
            return res.status(401).json({ success: false, message: "Team mismatch for this account" });
        }

        // 3. Verify Bcrypt Password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Incorrect Password" });
        }

        // 4. Collect Team Purse and Logo
        const team = await Team.findOne({ name: selectedTeam });
        
        // 5. Collect Current Squad (Finding players sold to this team)
        const squad = await Player.find({ 
            soldTo: { $regex: new RegExp('^' + selectedTeam) } 
        });

        // Send all data back to the Community Backend
        res.json({ 
            success: true, 
            teamName: user.name,
            purse: team ? team.budget : 0,
            logo: team ? team.logoUrl : "",
            squad: squad 
        });

    } catch (err) {
        console.error("Sync Route Error:", err);
        res.status(500).json({ success: false, message: "Auction Server Internal Error" });
    }
});
// --- AUCTION LOGIC & TIMER ---
let auctionState = { 
    activePlayerId: null, 
    currentBid: 0, 
    highestBidder: 'No Bids Yet', 
    timeLeft: 20,
    skippedTeams: [],
    isFinalCall: false,     // NEW
    finalCallText: "",
    isHidden: false


};
let timerInterval = null;
   // --- FEATURE 1: GHOST WATCH TRACKING ---
let focusedCaptains = new Set(); // Stores Socket IDs of focused captains

let slideshowState = {
    active: false,
    currentIndex: 0,
    players: []
};
let slideshowInterval = null;

function getFinalCallText(seconds) {
    if (seconds > 15) return "Are there any further bids?";
    if (seconds > 10) return "For the first time...";
    if (seconds > 5) return "For the second time...";
    if (seconds > 3) return "Going once...";
    if (seconds > 2) return "Going twice...";
    if (seconds > 0) return "SOLD!";
    return "SOLD!";
}

function startTimer() {
    clearInterval(timerInterval);
    // If it's a final call, we start from 30, otherwise standard 60 (or 120 as you mentioned)
    auctionState.timeLeft = auctionState.isFinalCall ? 17 : 20; 
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        
        if (auctionState.isFinalCall) {
            auctionState.finalCallText = getFinalCallText(auctionState.timeLeft);
        }
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer();
        } else {
            io.emit('updateAuction', auctionState);
        }
    }, 1000);
}

async function autoSellPlayer() {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        const price = auctionState.currentBid;
        const teamName = auctionState.highestBidder;
        const player = auctionState.activePlayerId;

        await Player.findByIdAndUpdate(player._id, {
            status: 'Sold',
            soldTo: `${teamName} (${price}M)`
        });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });
        await History.create({ playerName: player.name, price: price });
        
        // --- NEW BROADCAST EVENT ---
        io.emit('celebrateSold', {
            player: player,
            teamName: teamName,
            price: price
        });

        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        await broadcastStats();
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought ${player.name} for ${price}M.` });
    }
}
async function getStatsObject() {
    const players = await Player.find();
    const countTier = (tierName) => players.filter(p => 
        p.cardType && p.cardType.toLowerCase() === tierName.toLowerCase()
    ).length;

    return {
        total: players.length,
        sold: players.filter(p => p.status === 'Sold').length,
        unsold: players.filter(p => p.status === 'Unsold').length,
        tiers: {
            bigtime: countTier('BIG TIME'),
            epic: countTier('EPIC'),
            showtime: countTier('SHOWTIME'),
            highlight: countTier('HIGHLIGHT')
        }
    };
}
async function broadcastStats() {
    try {
        const players = await Player.find();
        
        // Helper to count tiers regardless of CAPS/lowercase
        const countTier = (tierName) => players.filter(p => 
            p.cardType && p.cardType.toLowerCase() === tierName.toLowerCase()
        ).length;

        const stats = {
            total: players.length,
            sold: players.filter(p => p.status === 'Sold').length,
            unsold: players.filter(p => p.status === 'Unsold').length,
            tiers: {
                bigtime: countTier('BIG TIME'),
                epic: countTier('EPIC'),
                showtime: countTier('SHOWTIME'),
                highlight: countTier('HIGHLIGHT')
            }
        };

        console.log("📊 Broadcasting Updated Stats:", stats);
        io.emit('updateGlobalStats', stats);
    } catch (err) {
        console.error("Stats Error:", err);
    }
}
// --- NEXUS DATA SYNC API ---
const DATA_SYNC_KEY = "NEXUS_SECRET_789"; // Change this to any secret word

app.get('/api/export-results', async (req, res) => {
    const apiKey = req.headers['x-api-key'];

    // 1. Security Check
    if (apiKey !== DATA_SYNC_KEY) {
        return res.status(403).json({ error: "Access Denied: Invalid Sync Key" });
    }

    try {
        // 2. Fetch all data
        const players = await Player.find();
        const teams = await Team.find();

        // 3. Format data for your other website
        const formattedData = players.map(p => {
            let teamName = "Free Agent";
            let soldPrice = 0;

            if (p.status === 'Sold' && p.soldTo.includes('(')) {
                const parts = p.soldTo.split('(');
                teamName = parts[0].trim();
                soldPrice = parseInt(parts[1].replace(')',''));
            }

            return {
                nexus_id: p._id,
                name: p.name,
                strength: p.strength,
                tier: p.cardType,
                whatsapp: p.phone,
                image: p.imageUrl,
                status: p.status,
                assigned_to: teamName,
                transfer_fee: soldPrice
            };
        });

        // 4. Send the package
        res.json({
            tournament_season: "2026-27",
            total_players: players.length,
            franchises: teams.map(t => ({ name: t.name, logo: t.logoUrl, remaining_purse: t.budget })),
            players: formattedData
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
const musicSchema = new mongoose.Schema({
    url: String,
    filename: String,
    timestamp: { type: Date, default: Date.now }
});
const Music = mongoose.model('Music', musicSchema);
app.post('/api/upload-music', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            console.log("❌ No file received in req.file");
            return res.status(400).send("No file uploaded");
        }

        console.log(`📤 Pushing ${req.file.originalname} to Catbox...`);

        const form = new FormData();
        form.append('reqtype', 'fileupload');
        // Ensure the buffer is passed correctly with a filename
        form.append('fileToUpload', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype,
        });

        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: { ...form.getHeaders() },
            timeout: 60000 // Give it 60 seconds (important for Render free tier)
        });

        // Catbox returns a plain string URL like "https://files.catbox.moe/xxxx.mp3"
        const fileUrl = response.data.trim();

        if (!fileUrl.includes('http')) {
            throw new Error("Invalid response from Catbox: " + fileUrl);
        }

        const newTrack = new Music({ url: fileUrl, filename: req.file.originalname });
        await newTrack.save();

        io.emit('newTrackAdded', fileUrl);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `🎵 Radio Sync: ${req.file.originalname} is now in rotation.` 
        });

        res.json({ success: true, url: fileUrl });
    } catch (err) {
        console.error("❌ Upload Route Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- SOCKETS ---
io.on('connection', async (socket) => {
    
    // ⬇️ FIXED: The array items MUST match the variable order exactly ⬇️
    const [players, teams, chats, stats, history, customMusic] = await Promise.all([
        Player.find(),
        Team.find(),
        Chat.find().sort({ timestamp: 1 }).limit(50), // 3. chats
        getStatsObject(),                            // 4. stats
        History.find().sort({ timestamp: 1 }).limit(70),// 5. history
        Music.find()                                 // 6. customMusic
    ]);

    socket.emit('initialData', {
        players, 
        teams, 
        chats, 
        state: auctionState, 
        stats, 
        history, 
        customMusic: customMusic.map(m => m.url) // Now correctly maps music URLs!
    });

    // --- NEW: AUTHENTICATION EVENTS ---

    
// --- HANDLE DIRECT CLOUD LINKS FROM ADMIN ---
socket.on('addMusicTrack', async (data) => {
    try {
        const { url, name } = data;

        // 1. Save URL to Database
        const newTrack = new Music({ url: url, filename: name || "Custom Track" });
        await newTrack.save();

        // 2. Force push the new song to everyone's active loop
        io.emit('newTrackAdded', url);

        // 3. Log to chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `🎵 Radio Sync: New track [${name}] has been added to rotation.` 
        });

    } catch (err) {
        console.error("Music Socket Error:", err);
    }
});
    // 2. Special Sign In (Captain/Admin)
    socket.on('specialSignIn', async ({ email, password, type }) => {
    try {
        // 1. Clean the inputs (remove spaces and force lowercase)
        const cleanEmail = email.trim().toLowerCase();
        const cleanRole = type.trim().toLowerCase();

        console.log(`Attempting login: ${cleanEmail} as ${cleanRole}`);

        // 2. Find the user matching BOTH email and role
        const user = await User.findOne({ 
            email: cleanEmail, 
            role: cleanRole 
        });
        
        if (!user) {
            console.log("Login Failed: User/Role combination not found.");
            return socket.emit('errorMsg', "Not Authorized: Account not found for this role.");
        }

        // 3. Check password
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (isMatch) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otp = otp;
            user.otpExpires = Date.now() + 600000; 
            await user.save();
            await sendOTPEmail(cleanEmail, otp);
            socket.emit('authStep', 'otp_verify');
        } else {
            socket.emit('errorMsg', "Incorrect Password.");
        }
    } catch (e) { 
        console.error(e);
        socket.emit('errorMsg', "Auth Error: Please try again."); 
    }
});
    socket.on('guestSignIn', () => {
    // Directly succeed without checking any password
    socket.emit('guestLoginSuccess', { name: "Guest Viewer", role: "guest" });
});

// --- ADMIN MANAGEMENT FUNCTIONS ---
socket.on('getAuthorizedUsers', async () => {
    // Only send non-visitors to admin
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});
    // --- 1. LINKED USER CREATION (WITH VARIABLE BUDGET) ---
socket.on('createNewUser', async (data) => {
    try {
        const hashedPassword = await bcrypt.hash(data.password, 10);
        const userEmail = data.email.trim().toLowerCase(); // Clean email
        const teamName = data.teamName.trim();
        const userRole = data.role.trim().toLowerCase(); // Clean role
        const customBudget = Number(data.budget) || 2000;

        await User.findOneAndUpdate(
            { email: userEmail },
            {
                name: teamName, 
                email: userEmail,
                password: hashedPassword,
                role: userRole, // Save as lowercase
                isVerified: true
            },
            { upsert: true }
        );
        
        // ... rest of the code (Team update etc)

        // Link to Franchise if role is captain
        if (data.role === 'captain') {
            await Team.findOneAndUpdate(
                { name: teamName },
                { name: teamName, budget: customBudget, initialBudget: customBudget },
                { upsert: true }
            );
        }

        // Send updated data to Admin
        const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
        const teams = await Team.find();
        io.emit('authorizedUsersList', users);
        io.emit('updateTeams', teams);
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ User ${userEmail} linked to ${teamName} with ${customBudget}M.` });

    } catch (err) {
        console.error("User Creation Error:", err);
        socket.emit('errorMsg', "Failed to create user. Check if email is unique.");
    }
});

// --- 2. FRANCHISE CREATION / BUDGET UPDATE ---
socket.on('createNewTeam', async ({ name, budget }) => {
    try {
        const teamName = name.trim();
        const teamBudget = Number(budget);

        await Team.findOneAndUpdate(
            { name: teamName },
            { name: teamName, budget: teamBudget, initialBudget: teamBudget },
            { upsert: true }
        );

        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Franchise [${teamName}] updated to ${teamBudget}M.` });
    } catch (err) {
        console.error("Franchise Error:", err);
        socket.emit('errorMsg', "Error managing franchise.");
    }
});

    
    socket.on('deleteAuthorizedUser', async (id) => {
    await User.findByIdAndDelete(id);
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});

    // 3. Verify OTP
    socket.on('verifyOTP', async ({ email, otp }) => {
        try {
            const user = await User.findOne({ 
                email, 
                otp, 
                otpExpires: { $gt: Date.now() } 
            });

            if (user) {
                user.isVerified = true;
                user.otp = undefined;
                await user.save();
                socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
            } else {
                socket.emit('errorMsg', "Invalid or Expired OTP");
            }
        } catch (err) {
            socket.emit('errorMsg', "Verification Error");
        }
    });

    // --- PREVIOUS AUCTION FUNCTIONS (UNTOUCHED) ---

    socket.on('addPlayer', async (data) => {
    try {
        const newPlayer = new Player({ 
            name: data.name,
            strength: Number(data.strength) || 3000,
            cardType: data.cardType || 'EPIC',
            baseValue: Number(data.baseValue) || 10,
            phone: String(data.phone || ""),
            ranking: Number(data.ranking) || 0,
            imageUrl: data.imageUrl || ""
        });
        await newPlayer.save();
        await broadcastStats();
        io.emit('updatePlayers', await Player.find()); 
    } catch (err) { 
        console.error("Add Player Error:", err); 
    }
});

    // Add 'isHidden' to the arguments list here:
socket.on('startAuction', async ({ playerId, baseValue, isHidden }) => { 
    const player = await Player.findById(playerId);
    if (player) {
        await Player.findByIdAndUpdate(playerId, { status: 'Available', soldTo: '-' });
        auctionState = { 
            activePlayerId: player, 
            currentBid: baseValue, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 20,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: "",
            isHidden: isHidden || false // Now it knows what isHidden is!
        };
        // Broadcast the status reset to the list
        io.emit('updatePlayers', await Player.find());
        io.emit('updateAuction', auctionState);
        
        // Optional: Notify the chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `📢 RE-ENTRY: ${player.name} is back on the auction block!` 
        });
        
        startTimer();
        await broadcastStats();
    }
});

    socket.on('startFinalCall', () => {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        auctionState.isFinalCall = true;
        startTimer(); // This will now start the 30s sequence
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "⚠️ ADMIN HAS INITIATED THE FINAL CALL!" });
    }
});
    socket.on('setTeamCapacity', async ({ teamId, capacity }) => {
    await Team.findByIdAndUpdate(teamId, { maxCapacity: Number(capacity) });
    await broadcastStats();
    io.emit('updateTeams', await Team.find());
    socket.emit('newMessage', { sender: "SYSTEM", text: "✅ Capacity Updated." });
});
    socket.on('revealPlayer', () => {
    auctionState.isHidden = false; // Reveal the player
    io.emit('updateAuction', auctionState);
    io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "🔓 MYSTERY REVEALED: A Legend has entered the block!" });
});

    socket.on('placeBid', async ({ teamName, increment }) => {
    // 1. Check if they already skipped
    if (auctionState.skippedTeams.includes(teamName)) {
        return socket.emit('errorMsg', "You skipped this round!");
    }

    // 2. Check if they are already the highest bidder
    if (auctionState.highestBidder === teamName) {
        return socket.emit('errorMsg', "You are already the highest bidder!");
    }

    const team = await Team.findOne({ name: teamName });
    const playerCount = await Player.countDocuments({ soldTo: new RegExp('^' + teamName) });

    if (playerCount >= team.maxCapacity) {
        return socket.emit('errorMsg', `🚫 SQUAD FULL! Limit is ${team.maxCapacity}.`);
    }
    const newBid = auctionState.currentBid + increment;

    if (team && team.budget >= newBid) {
        auctionState.currentBid = newBid;
        auctionState.highestBidder = teamName;

        // --- NEW CODE ADDED HERE ---
        // If someone bids, we cancel the Final Call and return to normal timer
        auctionState.isFinalCall = false;
        auctionState.finalCallText = "";
        // ---------------------------

        startTimer(); // This will now reset to 60s because isFinalCall is false
        io.emit('updateAuction', auctionState);
    }
});

    
    socket.on('skipRound', ({ teamName }) => {
    if (!auctionState.skippedTeams.includes(teamName)) {
        auctionState.skippedTeams.push(teamName);
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ ${teamName} has skipped this round.` 
        });
    }
});

    socket.on('sellPlayer', autoSellPlayer);
    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    socket.on('addBonus', async ({ teamName, amount }) => {
        try {
            await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: Number(amount) } });
            io.emit('updateTeams', await Team.find());
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✨ ${teamName} purse adjusted by ${amount}M!` });
        } catch (err) { console.error(err); }
    });
    // --- FORCE PURSE DEDUCTION (ADMIN ONLY) ---
socket.on('deductPurse', async ({ teamName, amount }) => {
    try {
        // Ensure the amount is treated as a negative number
        const deduction = -Math.abs(Number(amount));
        
        await Team.findOneAndUpdate(
            { name: teamName }, 
            { $inc: { budget: deduction } }
        );

        // Update all screens
        const updatedTeams = await Team.find();
        io.emit('updateTeams', updatedTeams);

        // Broadcast to chat with a Warning style
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ PENALTY: ${teamName} purse has been forcefully reduced by ${Math.abs(amount)}M!` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Force deduction failed.");
    }
});
    // --- ADMIN FEATURE: DIRECT ASSIGN (NO BUDGET DEDUCTION) ---
socket.on('adminForceAssign', async ({ playerId, teamName, price }) => {
    try {
        const player = await Player.findById(playerId);
        if (!player) return socket.emit('errorMsg', "Player not found.");

        const soldPrice = Number(price);

        // 1. Update Player (Mark as Sold with the specific value)
        await Player.findByIdAndUpdate(playerId, {
            status: 'Sold',
            soldTo: `${teamName} (${soldPrice}M)`
        });

        // 2. Save to History for the curved Graph
        await History.create({ playerName: player.name, price: soldPrice });

        // 3. Trigger the celebratory flashcard & fireworks for everyone
        io.emit('celebrateSold', {
            player: player,
            teamName: teamName,
            price: soldPrice
        });

        // 4. Global Refresh (Stats, Tables)
        const allPlayers = await Player.find();
        io.emit('updatePlayers', allPlayers);
        await broadcastStats();
        
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `📝 REGISTRATION: ${player.name} assigned to ${teamName} at ${soldPrice}M (Budget preserved).` 
        });

    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Assignment failed.");
    }
});
    // --- REDUCE SQUAD COUNT (RELEASE PLAYERS) ---
socket.on('reduceSquadCount', async ({ teamName, count }) => {
    try {
        // 1. Find the players sold to this team (limit by the number typed)
        // We sort by _id descending to remove the most recently bought players first
        const playersToRelease = await Player.find({ 
            soldTo: { $regex: new RegExp('^' + teamName) } 
        }).sort({ _id: -1 }).limit(Number(count));

        if (playersToRelease.length === 0) {
            return socket.emit('errorMsg', `Team ${teamName} has no players to release.`);
        }

        // 2. Loop through and reset them
        for (let p of playersToRelease) {
            await Player.findByIdAndUpdate(p._id, { 
                status: 'Available', 
                soldTo: '-' 
            });
        }

        // 3. Sync everything
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        await broadcastStats(); 
        
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `🔓 RELEASE: ${playersToRelease.length} player(s) removed from ${teamName}'s squad.` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Failed to release players.");
    }
});
    socket.on('updateTeamLogo', async ({ teamId, logoUrl }) => {
    await Team.findByIdAndUpdate(teamId, { logoUrl: logoUrl });
    io.emit('updateTeams', await Team.find());
});
    // --- ADMIN TEAM/FRANCHISE MANAGEMENT ---

// 1. Create a New Team
socket.on('createNewTeam', async ({ name, budget }) => {
    try {
        const newTeam = new Team({ 
            name: name.trim(), 
            budget: Number(budget) 
        });
        await newTeam.save();
        
        // Broadcast updated list to all users
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Team [${name}] created with ${budget}M budget.` });
    } catch (err) {
        socket.emit('errorMsg', "Team already exists or error occurred.");
    }
});

// 2. Delete a Team
socket.on('deleteTeam', async (id) => {
    try {
        await Team.findByIdAndDelete(id);
        
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: "❌ Team removed from the database." });
    } catch (err) {
        socket.emit('errorMsg', "Failed to delete team.");
    }
});
    socket.on('resetPurse', async ({ teamName }) => {
    try {
        const team = await Team.findOne({ name: teamName });
        if (team) {
            // Revert current budget to the initial value
            team.budget = team.initialBudget;
            await team.save();
            
            io.emit('updateTeams', await Team.find());
            io.emit('newMessage', { 
                sender: "SYSTEM", 
                role: "admin", 
                text: `♻️ RESET: ${teamName} purse reverted to original ${team.initialBudget}M.` 
            });
        }
    } catch (err) { console.error(err); }
});

    socket.on('sendMessage', async (data) => {
    try {
        // SERVER SIDE SECURITY: Only allow admin or captain roles to broadcast
        if (data.role === 'admin' || data.role === 'captain') {
            await new Chat(data).save();
            io.emit('newMessage', data);
        } else {
            console.log(`Blocked chat attempt from unauthorized role: ${data.role}`);
            // Optional: send an error only to that specific user
            socket.emit('errorMsg', "You do not have permission to send messages.");
        }
    } catch (err) {
        console.error("Chat Error:", err);
    }
});

    socket.on('deletePlayer', async (playerId) => {
        await Player.findByIdAndDelete(playerId);
        await broadcastStats();
        io.emit('updatePlayers', await Player.find()); 
    });
    // --- MEGA RESET (ADMIN ONLY) ---
socket.on('hardResetDatabase', async () => {
    // Safety check: only allow the master admin email to trigger this
    // You can also check if (user.role === 'admin')
    try {
        console.log("🚨 MEGA RESET INITIATED");

        // 1. Clear all collections
        await Player.deleteMany({});
        await Team.deleteMany({});
        await Chat.deleteMany({});
        
        // 2. Clear all users EXCEPT the Master Admin
        await User.deleteMany({ email: { $ne: "sarkaranubhav48@gmail.com" } });

        // 3. Reset the live auction state
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 20,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 4. Force refresh all connected clients
        io.emit('updatePlayers', []);
        io.emit('updateTeams', []);
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: "🚨 SYSTEM ALERT: Database has been wiped. A new tour can now begin." 
        });

        socket.emit('newMessage', { sender: "SYSTEM", text: "✅ Full Reset Successful." });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Reset failed: " + err.message);
    }
});
    // --- MARK PLAYER AS UNSOLD ---
socket.on('markUnsold', async () => {
    if (auctionState.activePlayerId) {
        const player = auctionState.activePlayerId;
        
        // 1. Update Player status in DB
        await Player.findByIdAndUpdate(player._id, { 
            status: 'Unsold', 
            soldTo: 'UNSOLD' 
        });

        // 2. Clear the timer
        clearInterval(timerInterval);

        // 3. Reset Auction State
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 0,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 4. Broadcast updates
        io.emit('updatePlayers', await Player.find());
        io.emit('updateAuction', auctionState);
        await broadcastStats();
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `❌ UNSOLD: ${player.name} has been moved to the unsold list.` 
        });
    }
});
    // --- DELETE ONLY PLAYERS (ADMIN ONLY) ---
socket.on('clearOnlyPlayers', async () => {
    try {
        console.log("🚨 ROSTER CLEAR INITIATED");

        // 1. Delete all records from the Player collection only
        await Player.deleteMany({});

        // 2. Reset the live auction state (to prevent errors if a player was live)
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 20,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 3. Broadcast updates to all screens
        io.emit('updatePlayers', []);
        io.emit('updateAuction', auctionState);
        await broadcastStats();
        
        // 4. Send a system message to the chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: "🚨 ADMIN ALERT: The player roster has been cleared. Teams and Accounts remain active." 
        });

        socket.emit('newMessage', { sender: "SYSTEM", text: "✅ Roster cleared successfully." });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Failed to clear players.");
    }
});

socket.on('updateFocus', (isFocused) => {
    // We only care if the user is a captain
    if (isFocused) {
        focusedCaptains.add(socket.id);
    } else {
        focusedCaptains.delete(socket.id);
    }
    // Broadcast the COUNT of focused captains to everyone
    io.emit('ghostWatchCount', focusedCaptains.size);
});

// Ensure they are removed if they disconnect
socket.on('disconnect', () => {
    focusedCaptains.delete(socket.id);
    io.emit('ghostWatchCount', focusedCaptains.size);
});
    // --- PUBLIC RELAY (ZERO MONGODB USAGE) ---
socket.on('public_msg_send', async (data) => {
    // 1. Show the user's message in the public chat immediately
    io.emit('public_msg_receive', data);

    const userText = data.text.trim();

    // 2. Check for Bot Command
    if (userText.toLowerCase().startsWith('@nexus')) {
        try {
            // --- DATA GATHERING (The "Reading" part) ---
            const [players, teams] = await Promise.all([
                Player.find(),
                Team.find()
            ]);

            const activePlayer = auctionState.activePlayerId ? 
                `${auctionState.activePlayerId.name} (${auctionState.activePlayerId.cardType}) at ${auctionState.currentBid}M. Highest bidder: ${auctionState.highestBidder}` : 
                "None (Waiting for nomination)";

            const recentSales = players.filter(p => p.status === 'Sold')
                .slice(-5).map(p => `${p.name} -> ${p.soldTo}`).join(', ');

            const teamFinancials = teams.map(t => {
                const count = players.filter(p => p.soldTo.includes(t.name)).length;
                return `${t.name}: ${t.budget}M remaining (${count}/${t.maxCapacity} slots)`;
            }).join(' | ');

            // --- SYSTEM PROMPT (The "Personality & Logic") ---
            const systemContext = `
                You are Nexus AI, the high-tech automated system for the Champions Auction League. 
                You have access to the internal database. 
                
                LIVE DATABASE SNAPSHOT:
                - Currently on Block: ${activePlayer}
                - Franchise Status: ${teamFinancials}
                - Recent Transfers: ${recentSales || "No sales yet"}
                - Total Pool: ${players.length} players
                
                INSTRUCTIONS:
                - Answer based ONLY on the snapshot data above.
                - Be brief, technical, and professional. 
                - Use a "System Notification" tone. 
                - Use football and tech emojis.
            `;

            // --- CALL GROQ ---
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemContext },
                    { role: "user", content: userText.replace('@nexus', '') }
                ],
                model: "llama-3.1-8b-instant", // Fast and smart
                temperature: 0.5,
                max_tokens: 150
            });

            const botResponse = completion.choices[0].message.content;

            // --- BROADCAST BOT REPLY ---
            io.emit('public_msg_receive', {
                sender: "NEXUS AI",
                role: "bot",
                text: botResponse
            });

        } catch (err) {
            console.error("Groq AI Error:", err);
            // Fallback if API fails
            io.emit('public_msg_receive', {
                sender: "NEXUS AI",
                role: "bot",
                text: "⚠️ [SYSTEM ERROR]: Connection to AI Core lost. Recalibrating..."
            });
        }
    }
});
    // --- PUBLIC REACTION RELAY (ZERO DB PRESSURE) ---
socket.on('public_reaction_send', (emoji) => {
    // Immediate broadcast to everyone
    io.emit('public_reaction_receive', emoji);
});
    // --- SLIDESHOW LOGIC ---
    socket.on('toggleSlideshow', async (shouldStart) => {
        if (shouldStart) {
            const unsoldPlayers = await Player.find({ status: 'Unsold' });
            if (unsoldPlayers.length === 0) return socket.emit('errorMsg', "No unsold players to show!");
            
            slideshowState = { active: true, currentIndex: 0, players: unsoldPlayers };
            io.emit('updateSlideshow', slideshowState);

            // Auto-rotate every 5 seconds
            clearInterval(slideshowInterval);
            slideshowInterval = setInterval(() => {
                slideshowState.currentIndex = (slideshowState.currentIndex + 1) % slideshowState.players.length;
                io.emit('updateSlideshow', slideshowState);
            }, 5000);
        } else {
            clearInterval(slideshowInterval);
            slideshowState = { active: false, currentIndex: 0, players: [] };
            io.emit('updateSlideshow', slideshowState);
        }
    });
    // Inside io.on('connection', (socket) => { ... })
socket.on('sendReaction', (emoji) => {
    // Relay to everyone including the sender
    io.emit('newReaction', emoji);
});
    socket.on('bulkAddPlayers', async (playersArray) => {
    try {
        // Insert all players at once
        await Player.insertMany(playersArray);
        await broadcastStats();
        
        // Refresh the list for everyone
        const allPlayers = await Player.find();
        io.emit('updatePlayers', allPlayers);
        
        // Send success message back to the admin who uploaded
        socket.emit('bulkImportSuccess', `Successfully imported ${playersArray.length} players!`);
        
        // Log to chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `📢 DATABASE SYNC: ${playersArray.length} new players registered via CSV.` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Database Import Failed: " + err.message);
    }
});


    // Add this inside your io.on('connection', ...) block
socket.on('updatePlayerImage', async ({ playerId, imageUrl }) => {
    try {
        await Player.findByIdAndUpdate(playerId, { imageUrl: imageUrl });
        
        // Refresh the list for everyone
        const updatedPlayers = await Player.find();
        io.emit('updatePlayers', updatedPlayers);
        
        // If this player is currently live, update the auction screen too
        if (auctionState.activePlayerId && auctionState.activePlayerId._id.toString() === playerId) {
            auctionState.activePlayerId.imageUrl = imageUrl;
            io.emit('updateAuction', auctionState);
        }
        
        socket.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "✅ Player image updated successfully!" });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Failed to update image");
    }
});

    // --- 1. GENERATE COMPLETE DATABASE BACKUP ---
socket.on('requestDatabaseBackup', async () => {
    if (!requireAdmin()) return;
    try {
        const [players, teams, chats, history, music, users] = await Promise.all([
            Player.find().lean(),
            Team.find().lean(),
            Chat.find().lean(),
            History.find().lean(),
            Music.find().lean(),
            User.find({ role: { $ne: 'visitor' } }).lean() // Backs up captains/admins
        ]);

        const backupData = {
            version: "1.0",
            exportDate: new Date().toISOString(),
            data: { players, teams, chats, history, music, users }
        };

        socket.emit('downloadBackupData', backupData);
        console.log("📦 Full Database Snapshot exported by Admin.");
    } catch (err) {
        console.error("Backup Error:", err);
        socket.emit('errorMsg', "Failed to create database backup.");
    }
});

// --- 2. RESTORE COMPLETE DATABASE FROM BACKUP ---
socket.on('restoreDatabaseFromBackup', async (backupPayload) => {
    if (!requireAdmin()) return;
    try {
        if (!backupPayload || !backupPayload.data) {
            return socket.emit('errorMsg', "Invalid Backup file structure.");
        }

        console.log("🔄 Initiating Emergency Database Recovery...");
        const { players, teams, chats, history, music, users } = backupPayload.data;

        // 1. Wipe current tables clean to prevent duplicate _id conflicts
        await Promise.all([
            Player.deleteMany({}),
            Team.deleteMany({}),
            Chat.deleteMany({}),
            History.deleteMany({}),
            Music.deleteMany({}),
            User.deleteMany({ role: { $ne: 'visitor' } })
        ]);

        // 2. Restore all data from the snapshot
        if (players && players.length) await Player.insertMany(players);
        if (teams && teams.length) await Team.insertMany(teams);
        if (chats && chats.length) await Chat.insertMany(chats);
        if (history && history.length) await History.insertMany(history);
        if (music && music.length) await Music.insertMany(music);
        if (users && users.length) await User.insertMany(users);

        // 3. Reset live auction state
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 20,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 4. Broadcast the recovered data globally to all screens
        const allPlayers = await Player.find();
        const allTeams = await Team.find();
        const allStats = await getStatsObject();

        io.emit('updatePlayers', allPlayers);
        io.emit('updateTeams', allTeams);
        io.emit('updateGlobalStats', allStats);
        io.emit('updateAuction', auctionState);
        
        io.emit('newMessage', {
            sender: "SYSTEM",
            role: "admin",
            text: "♻️ SYSTEM RESTORE: Database was successfully recovered from a previous backup."
        });

        socket.emit('restoreCompleteSuccess', `Successfully restored ${players.length} players, ${teams.length} teams, and accounts!`);
    } catch (err) {
        console.error("Restore Error:", err);
        socket.emit('errorMsg', "Restoration Failed: " + err.message);
    }
});
    // --- CLEAR ALL CUSTOM MUSIC TRACKS ---
socket.on('clearAllMusic', async () => {
    try {
        // Delete all records from the Music collection
        await Music.deleteMany({});
        
        // Broadcast clear event to all connected clients
        io.emit('musicCleared');

        // Log to system chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `🗑️ Radio Reset: All custom music tracks were cleared from the database.` 
        });

        console.log("🗑️ All custom music tracks deleted by admin.");
    } catch (err) {
        console.error("Clear Music Error:", err);
        socket.emit('errorMsg', "Failed to clear music tracks.");
    }
});
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
