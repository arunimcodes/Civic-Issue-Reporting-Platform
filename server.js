const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(cors()); // <-- ADD THIS LINE (This is the VIP pass!)
app.use(express.json({ limit: '50mb' }));
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// --- 1. BUILD THE DATABASE CONNECTION (POOL) ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- 2. AUTO-FIX DATABASE COLUMN ON STARTUP ---
pool.query("ALTER TABLE complaints MODIFY COLUMN photo_url LONGTEXT")
    .then(() => console.log("✅ Database fix applied: photo_url is now a massive LONGTEXT container!"))
    .catch((err) => console.log("Database fix note:", err.message));
// ----------------------------------------------


// Test the connection
pool.getConnection()
    .then(() => console.log("✅ Successfully connected to MySQL Database 'cd'"))
    .catch((err) => console.error("❌ MySQL connection error:", err));

// Email Transporter Setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- 2. API ROUTES ---

// Route 1: Smart Login (Admin needs password, Citizens do not)
app.post('/api/login', async (req, res) => {
    try {
        // SAFETY NET: If username or password are missing, default to empty strings
        const username = req.body.username || req.body.email || '';
        const password = req.body.password || '';
        const userLower = username.toLowerCase().trim();
        // 1. ADMIN LOGIN
        if (userLower === 'admin') {
            if (password === process.env.ADMIN_PASSWORD) {
                return res.json({ success: true, role: 'admin' });
            } else {
                return res.status(401).json({ success: false, message: "Incorrect Admin Password!" });
            }
        }

        
        // 2. CITIZEN LOGIN (No password required)
        if (userLower !== '') {
            return res.json({ success: true, role: 'citizen' });
        }

        return res.status(400).json({ success: false, message: "Please enter a username to continue." });

    } catch (error) {
        console.error("LOGIN ERROR:", error);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// Route 2: Submit a New Report (Inserting into 'complaints' table)
app.post('/api/reports', async (req, res) => {
    try {
        const { id, title, category, municipality, location, email, image, status } = req.body;
        const name = "Concerned Citizen"; // Fallback since 'name' is required in your SQL schema

        const query = `
            INSERT INTO complaints 
            (id, name, category, location, email, municipality, description, photo_url, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await pool.query(query, [id, name, category, location, email, municipality, title, image, status]);
        
        res.json({ success: true, message: "Report saved to MySQL database." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Failed to save report." });
    }
});

// Route 3: Get All Reports (For Admin Dashboard)
app.get('/api/reports', async (req, res) => {
    try {
        // Fetch all complaints, newest first
        const [rows] = await pool.query('SELECT * FROM complaints ORDER BY created_at DESC');
        
        // Map the SQL columns to what the frontend expects
        const formattedReports = rows.map(row => ({
            trackingId: row.id,
            title: row.description, 
            category: row.category,
            location: row.location,
            municipality: row.municipality,
            image: row.photo_url,
            status: row.status,
            email: row.email,
            priority: row.category === 'Electric Issue' ? 'High' : 'Normal'
        }));

        res.json(formattedReports);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch reports." });
    }
});

// Route 4: Get Leaderboard Data (Using SQL GROUP BY)
app.get('/api/leaderboard', async (req, res) => {
    try {
        // This SQL query does all the math for us instantly
        const query = `
            SELECT 
                municipality AS name,
                COUNT(*) AS totalIssues,
                SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolvedIssues
            FROM complaints
            WHERE municipality IS NOT NULL
            GROUP BY municipality
            ORDER BY (resolvedIssues / totalIssues) DESC
        `;
        
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch leaderboard data." });
    }
});

// Route 5: Admin Marks Issue as Resolved
app.put('/api/reports/:id/resolve', async (req, res) => {
    try {
        const reportId = req.params.id;
        
        // Update the status in MySQL
        const [result] = await pool.query('UPDATE complaints SET status = ? WHERE id = ?', ['Resolved', reportId]);

        if (result.affectedRows === 0) return res.status(404).json({ error: "Report not found" });

        // Fetch the user's email to send the notification
        const [rows] = await pool.query('SELECT email, description, location FROM complaints WHERE id = ?', [reportId]);
        const updatedReport = rows[0];

        if (updatedReport && updatedReport.email) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: updatedReport.email,
                subject: Resolved: Civic Issue ${reportId},
                text: Hello, \n\nGreat news! Your reported issue regarding "${updatedReport.description}" at ${updatedReport.location} has been marked as RESOLVED.\n\n- Civic Resolve Team
            };
            await transporter.sendMail(mailOptions);
        }

        res.json({ success: true, message: "Resolved and email sent!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Route 6: AI Chatbot Logic
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
app.post('/api/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;
        const model = genAI.getGenerativeModel({ 
            model:"gemini-flash-latest",
            systemInstruction: "You are an assistant for a civic issue reporting system. Help users categorize problems like potholes, water leaks, or streetlights. Detect the user's language and reply in the same language."
        });

        const result = await model.generateContent(userMessage);
        res.json({ reply: result.response.text() });
     } catch (error) {
        console.error("AI ERROR DETAILS:", error); // <-- I added this line!
        res.status(500).json({ reply: "Sorry, I am having trouble connecting to the AI brain right now." });
    }
    
});

// --- 3. START SERVER ---
// Paste it right here!
app.get('/api/fix-db', async (req, res) => {
    try {
        await pool.query("ALTER TABLE complaints MODIFY COLUMN photo_url LONGTEXT");
        res.send("<h1>✅ Success! You can submit photos now!</h1>");
    } catch (error) { 
        res.send("<h1>❌ Failed: " + error.message + "</h1>"); 
    }
});

// This should be your existing code at the very bottom
app.listen(PORT, () => {
    console.log(✅ Server is running on http://localhost:${PORT});
});