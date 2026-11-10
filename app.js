const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const Database = require("better-sqlite3");
const formidable = require("formidable");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

const listingsDB = new Database("database.db");
const usersDB = new Database("users.db");

const DEFAULT_ADMIN_EMAILS = [
  "adminemail@gmail.com"
].map(email => email.toLowerCase());

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = [".heic", ".jpg", ".png"];

const wordList = fs.readFileSync("words.txt", "utf-8")
  .split("\n")
  .map(w => w.trim())
  .filter(w => w.length > 0);

usersDB.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password TEXT
)
`).run();

usersDB.prepare(`
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
)
`).run();

usersDB.prepare(`
CREATE TABLE IF NOT EXISTS banned_users (
  email TEXT PRIMARY KEY,
  bannedAt TEXT
)
`).run();

usersDB.prepare(`
CREATE TABLE IF NOT EXISTS admin_users (
  email TEXT PRIMARY KEY,
  promotedAt TEXT
)
`).run();

DEFAULT_ADMIN_EMAILS.forEach(email => {
  usersDB.prepare(`
    INSERT OR IGNORE INTO admin_users (email, promotedAt)
    VALUES (?, ?)
  `).run(email, new Date().toISOString());
});

listingsDB.prepare(`
CREATE TABLE IF NOT EXISTS listings (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  desc TEXT,
  price TEXT,
  imageLink TEXT,
  sellerName TEXT,
  category TEXT,
  status TEXT,
  dateListed TEXT
)
`).run();

listingsDB.prepare(`
CREATE TABLE IF NOT EXISTS listing_interests (
  id TEXT PRIMARY KEY,
  listingUuid TEXT,
  interestedEmail TEXT,
  createdAt TEXT,
  UNIQUE(listingUuid, interestedEmail)
)
`).run();

const listingColumns = listingsDB.prepare(`PRAGMA table_info(listings)`).all();

if (!listingColumns.some(col => col.name === "status")) {
  listingsDB.prepare(`ALTER TABLE listings ADD COLUMN status TEXT DEFAULT 'Active'`).run();
}

if (!listingColumns.some(col => col.name === "category")) {
  listingsDB.prepare(`ALTER TABLE listings ADD COLUMN category TEXT DEFAULT ''`).run();
}

if (!listingColumns.some(col => col.name === "dateListed")) {
  listingsDB.prepare(`ALTER TABLE listings ADD COLUMN dateListed TEXT DEFAULT ''`).run();
}

if (!fs.existsSync("images")) {
  fs.mkdirSync("images");
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "adminemail@gmail.com",
    pass: "your_app_password_here"
  }
});

const EMAIL_FROM = "adminemail@gmail.com";

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server error");
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};

  cookieHeader.split(";").forEach(part => {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) return;
    cookies[rawKey] = rest.join("=");
  });

  return cookies;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isAdminEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const admin = usersDB.prepare(`
    SELECT email
    FROM admin_users
    WHERE email = ?
  `).get(normalized);

  return !!admin;
}

function isBanned(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const banned = usersDB.prepare(`
    SELECT email
    FROM banned_users
    WHERE email = ?
  `).get(normalized);

  return !!banned;
}

function getUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.session;
  if (!sessionId) return null;

  const now = Date.now();

  const session = usersDB.prepare(`
    SELECT email, expiresAt
    FROM sessions
    WHERE sessionId = ?
  `).get(sessionId);

  if (!session) return null;

  if (session.expiresAt < now || isBanned(session.email)) {
    usersDB.prepare(`
      DELETE FROM sessions
      WHERE sessionId = ?
    `).run(sessionId);
    return null;
  }

  return session.email;
}

function createSession(email) {
  const sessionId = randomUUID();
  const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);

  usersDB.prepare(`
    INSERT INTO sessions (sessionId, email, expiresAt)
    VALUES (?, ?, ?)
  `).run(sessionId, email, expiresAt);

  return { sessionId, expiresAt };
}

function clearSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.session;
  if (!sessionId) return;

  usersDB.prepare(`
    DELETE FROM sessions
    WHERE sessionId = ?
  `).run(sessionId);
}

function generatePassword() {
  let result = "";

  for (let i = 0; i < 3; i++) {
    let word = wordList[Math.floor(Math.random() * wordList.length)];
    word = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    result += word;
  }

  return result;
}

async function sendPasswordEmail(toEmail, subject, password) {
  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to: toEmail,
    subject,
    text: `Your Hallpay password is: ${password}\n\n By creating an account, you are required to follow the Terms of Service found at the tos page. \n\n `
  });

  console.log("EMAIL SENT:", info.response);
}

async function sendInterestEmails(listing, interestedEmail) {
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: listing.sellerName,
    replyTo: interestedEmail,
    subject: `Someone is interested in your Hallpay listing: ${listing.name}`,
    text:
`Someone is interested in your listing.

Listing: ${listing.name}
Price: $${Number(listing.price).toFixed(2)}

Interested buyer: ${interestedEmail}

Reply directly to this email to contact them.`
  });

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: interestedEmail,
    replyTo: listing.sellerName,
    subject: `You marked interest in: ${listing.name}`,
    text:
`You marked that you are interested in this Hallpay listing.

Listing: ${listing.name}
Price: $${Number(listing.price).toFixed(2)}
Seller: ${listing.sellerName}

Reply directly to this email to contact the seller.`
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function getFieldValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeStatus(status) {
  const allowed = ["Sold", "Active", "Hidden"];
  return allowed.includes(status) ? status : "Active";
}

function isNumericPrice(value) {
  if (value === null || value === undefined) return false;
  const trimmed = String(value).trim();
  if (trimmed === "") return false;
  return !Number.isNaN(Number(trimmed));
}

function normalizePrice(value) {
  return Number(value).toString();
}

function isAllowedUpload(file) {
  if (!file) return false;

  const originalName = file.originalFilename || "";
  const ext = path.extname(originalName).toLowerCase();

  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) return false;
  if (file.size > MAX_UPLOAD_BYTES) return false;

  return true;
}

function deleteTempUpload(file) {
  if (file && file.filepath && fs.existsSync(file.filepath)) {
    fs.unlinkSync(file.filepath);
  }
}

function deleteListingImage(imageLink) {
  if (!imageLink || !imageLink.startsWith("/images/")) return;

  const imagePath = "." + imageLink;

  if (fs.existsSync(imagePath)) {
    fs.unlinkSync(imagePath);
  }
}

function getListingsWithInterestCounts(sql, params = []) {
  const rows = listingsDB.prepare(sql).all(...params);

  return rows.map(row => {
    const interest = listingsDB.prepare(`
      SELECT COUNT(*) AS count
      FROM listing_interests
      WHERE listingUuid = ?
    `).get(row.uuid);

    return {
      ...row,
      interestedCount: interest.count
    };
  });
}

usersDB.prepare(`
  DELETE FROM sessions
  WHERE expiresAt < ?
`).run(Date.now());

const server = http.createServer(async (req, res) => {
  const userEmail = getUser(req);
  const isAdmin = isAdminEmail(userEmail);

  const publicRoutes = [
    "/login",
    "/signup",
    "/forgot-password",
    "/market.js",
    "/style.css",
	"/hallpaylogo.png",
	"/hallpaylogofull.png",
	"/tos"
  ];

  const isPublic =
    publicRoutes.includes(req.url) ||
    req.url.startsWith("/images/");

  if (!isPublic && !userEmail) {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/login") {
    sendFile(res, "login.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/signup") {
    sendFile(res, "signup.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/home") {
    sendFile(res, "home.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/tos") {
    sendFile(res, "tos.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/listings-page") {
    sendFile(res, "listings.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/create") {
    sendFile(res, "create.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/modify-page") {
    sendFile(res, "modify.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/admin-page") {
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Admins only");
      return;
    }

    sendFile(res, "admin.html", "text/html");
  }

  else if (req.method === "GET" && req.url === "/") {
    res.writeHead(302, { Location: "/home" });
    res.end();
  }

  else if (req.method === "GET" && req.url === "/hallpaylogo.png") {
    sendFile(res, "hallpaylogo.png", "image/png");
  }
  
  else if (req.method === "GET" && req.url === "/hallpaylogofull.png") {
  sendFile(res, "hallpaylogofull.png", "image/png");
  }

  else if (req.method === "GET" && req.url === "/me") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      email: userEmail,
      isAdmin: isAdmin
    }));
  }

  else if (req.method === "POST" && req.url === "/signup") {
    try {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);

      if (!email) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing email");
        return;
      }

      if (isBanned(email)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("This account is banned");
        return;
      }

      const existingUser = usersDB.prepare(`
        SELECT id
        FROM users
        WHERE email = ?
      `).get(email);

      if (existingUser) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("User already exists");
        return;
      }

      const rawPassword = generatePassword();
      const hashedPassword = await bcrypt.hash(rawPassword, 10);
      const userId = randomUUID();

      usersDB.prepare(`
        INSERT INTO users (id, email, password)
        VALUES (?, ?, ?)
      `).run(userId, email, hashedPassword);

      try {
        await sendPasswordEmail(email, "Your Hallpay Password", rawPassword);
      } catch (mailErr) {
        console.error("EMAIL SEND ERROR AFTER SIGNUP:", mailErr);

        usersDB.prepare(`
          DELETE FROM users
          WHERE id = ?
        `).run(userId);

        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Could not send signup email");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Account created. Check your email.");
    } catch (err) {
      console.error("SIGNUP ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Signup failed");
    }
  }

  else if (req.method === "POST" && req.url === "/login") {
    try {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const password = body.password;

      if (!email || !password) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing email or password");
        return;
      }

      if (isBanned(email)) {
        usersDB.prepare(`
          DELETE FROM sessions
          WHERE email = ?
        `).run(email);

        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("This account is banned");
        return;
      }

      const user = usersDB.prepare(`
        SELECT *
        FROM users
        WHERE email = ?
      `).get(email);

      if (!user) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Invalid login");
        return;
      }

      const ok = await bcrypt.compare(password, user.password);

      if (!ok) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Invalid login");
        return;
      }

      const { sessionId } = createSession(email);

      res.writeHead(200, {
        "Set-Cookie": `session=${sessionId}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`,
        "Content-Type": "text/plain"
      });
      res.end("OK");
    } catch (err) {
      console.error("LOGIN ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Login failed");
    }
  }

  else if (req.method === "POST" && req.url === "/forgot-password") {
    try {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);

      if (!email) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing email");
        return;
      }

      if (isBanned(email)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("This account is banned");
        return;
      }

      const user = usersDB.prepare(`
        SELECT *
        FROM users
        WHERE email = ?
      `).get(email);

      if (!user) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No account found");
        return;
      }

      const newPassword = generatePassword();
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      usersDB.prepare(`
        UPDATE users
        SET password = ?
        WHERE email = ?
      `).run(hashedPassword, email);

      await sendPasswordEmail(email, "Your Hallpay Password Reset", newPassword);

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("A new password was sent to your email.");
    } catch (err) {
      console.error("FORGOT PASSWORD ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Password reset failed");
    }
  }

  else if (req.method === "POST" && req.url === "/logout") {
    clearSession(req);

    res.writeHead(200, {
      "Set-Cookie": "session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax",
      "Content-Type": "text/plain"
    });
    res.end("OK");
  }

  else if (req.method === "POST" && req.url === "/admin-ban-user") {
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Admins only");
      return;
    }

    try {
      const body = await readJsonBody(req);
      const emailToBan = normalizeEmail(body.email);

      if (!emailToBan) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing email");
        return;
      }

      if (isAdminEmail(emailToBan)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("You cannot ban an admin account");
        return;
      }

      usersDB.prepare(`
        INSERT OR REPLACE INTO banned_users (email, bannedAt)
        VALUES (?, ?)
      `).run(emailToBan, new Date().toISOString());

      usersDB.prepare(`
        DELETE FROM sessions
        WHERE email = ?
      `).run(emailToBan);

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User banned and logged out");
    } catch (err) {
      console.error("BAN USER ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Ban failed");
    }
  }
	else if (req.method === "POST" && req.url === "/admin-unban-user") {
  if (!isAdmin) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Admins only");
    return;
  }

  try {
    const body = await readJsonBody(req);
    const emailToUnban = normalizeEmail(body.email);

    if (!emailToUnban) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing email");
      return;
    }

    const result = usersDB.prepare(`
      DELETE FROM banned_users
      WHERE email = ?
    `).run(emailToUnban);

    if (result.changes === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("User was not banned");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("User unbanned");
  } catch (err) {
    console.error("UNBAN USER ERROR:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Unban failed");
  }
}

  else if (req.method === "POST" && req.url === "/save") {
    const form = new formidable.IncomingForm({
      uploadDir: "images",
      keepExtensions: true,
      maxFileSize: MAX_UPLOAD_BYTES
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error("SAVE ERROR:", err);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Upload error: file must be 10MB or smaller");
        return;
      }

      const fileArray = files.image;
      const file = Array.isArray(fileArray) ? fileArray[0] : fileArray;

      if (!file) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing image");
        return;
      }

      if (!isAllowedUpload(file)) {
        deleteTempUpload(file);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid file. Upload must be .heic, .jpg, or .png and 10MB or smaller.");
        return;
      }

      const rawPrice = getFieldValue(fields.price);

      if (!isNumericPrice(rawPrice)) {
        deleteTempUpload(file);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Price must be numeric");
        return;
      }

      const ext = path.extname(file.originalFilename || "").toLowerCase();
      const newName = randomUUID() + ext;
      const newPath = path.join("images", newName);

      fs.renameSync(file.filepath, newPath);

      listingsDB.prepare(`
        INSERT INTO listings (
          uuid, name, desc, price, imageLink, sellerName, category, status, dateListed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        getFieldValue(fields.name) || "",
        getFieldValue(fields.desc) || "",
        normalizePrice(rawPrice),
        "/images/" + newName,
        userEmail,
        getFieldValue(fields.category) || "",
        "Active",
        new Date().toISOString()
      );

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Saved");
    });
  }

  else if (req.method === "POST" && req.url === "/mark-interest") {
    try {
      const body = await readJsonBody(req);
      const uuid = body.uuid;

      if (!uuid) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing listing id");
        return;
      }

      const listing = listingsDB.prepare(`
        SELECT *
        FROM listings
        WHERE uuid = ?
      `).get(uuid);

      if (!listing) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Listing not found");
        return;
      }

      if (listing.status !== "Active") {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("This listing is not active");
        return;
      }

      if (listing.sellerName === userEmail) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("You cannot mark interest in your own listing");
        return;
      }

      try {
        listingsDB.prepare(`
          INSERT INTO listing_interests (id, listingUuid, interestedEmail, createdAt)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), uuid, userEmail, new Date().toISOString());
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("You already marked interest in this item");
        return;
      }

      try {
        await sendInterestEmails(listing, userEmail);
      } catch (mailErr) {
        console.error("INTEREST EMAIL ERROR:", mailErr);
      }

      const interest = listingsDB.prepare(`
        SELECT COUNT(*) AS count
        FROM listing_interests
        WHERE listingUuid = ?
      `).get(uuid);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        message: "Interest sent",
        interestedCount: interest.count
      }));
    } catch (err) {
      console.error("MARK INTEREST ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Interest failed");
    }
  }

  else if (req.method === "POST" && req.url === "/update-listing") {
    try {
      const { uuid, name, desc, price, category, status } = await readJsonBody(req);

      if (!uuid) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing listing id");
        return;
      }

      if (!isNumericPrice(price)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Price must be numeric");
        return;
      }

      const listing = listingsDB.prepare(`
        SELECT *
        FROM listings
        WHERE uuid = ?
      `).get(uuid);

      if (!listing) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Listing not found");
        return;
      }

      if (!isAdmin && listing.sellerName !== userEmail) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Not allowed");
        return;
      }

      listingsDB.prepare(`
        UPDATE listings
        SET
          name = ?,
          desc = ?,
          price = ?,
          category = ?,
          status = ?
        WHERE uuid = ?
      `).run(
        name || "",
        desc || "",
        normalizePrice(price),
        category || "",
        normalizeStatus(status),
        uuid
      );

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Updated");
    } catch (err) {
      console.error("UPDATE LISTING ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Update failed");
    }
  }

  else if (req.method === "POST" && req.url === "/delete-listing") {
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Admins only");
      return;
    }

    try {
      const body = await readJsonBody(req);
      const uuid = body.uuid;

      if (!uuid) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing listing id");
        return;
      }

      const listing = listingsDB.prepare(`
        SELECT *
        FROM listings
        WHERE uuid = ?
      `).get(uuid);

      if (!listing) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Listing not found");
        return;
      }

      deleteListingImage(listing.imageLink);

      listingsDB.prepare(`
        DELETE FROM listing_interests
        WHERE listingUuid = ?
      `).run(uuid);

      listingsDB.prepare(`
        DELETE FROM listings
        WHERE uuid = ?
      `).run(uuid);

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Listing deleted");
    } catch (err) {
      console.error("DELETE LISTING ERROR:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Delete failed");
    }
  }

  else if (req.method === "GET" && req.url.startsWith("/listings")) {
    const url = new URL(req.url, "http://localhost");
    const phrase = (url.searchParams.get("phrase") || "").trim().toLowerCase();
    const minPrice = (url.searchParams.get("minPrice") || "").trim();
    const maxPrice = (url.searchParams.get("maxPrice") || "").trim();
    const category = (url.searchParams.get("category") || "").trim();
    const includeSold = url.searchParams.get("includeSold") === "true";

    let rows = getListingsWithInterestCounts(`
      SELECT *
      FROM listings
      WHERE status != 'Hidden'
      ORDER BY rowid DESC
    `);

    rows = rows.filter(item => {
      const status = item.status || "Active";
      if (status === "Active") return true;
      if (status === "Sold" && includeSold) return true;
      return false;
    });

    if (phrase) {
      rows = rows.filter(item => {
        const name = String(item.name || "").toLowerCase();
        const desc = String(item.desc || "").toLowerCase();
        return name.includes(phrase) || desc.includes(phrase);
      });
    }

    if (minPrice !== "" && !Number.isNaN(Number(minPrice))) {
      rows = rows.filter(item => Number(item.price) >= Number(minPrice));
    }

    if (maxPrice !== "" && !Number.isNaN(Number(maxPrice))) {
      rows = rows.filter(item => Number(item.price) <= Number(maxPrice));
    }

    if (category) {
      rows = rows.filter(item => String(item.category || "") === category);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  }

  else if (req.method === "GET" && req.url === "/my-listings") {
    const rows = getListingsWithInterestCounts(`
      SELECT *
      FROM listings
      WHERE sellerName = ?
      ORDER BY rowid DESC
    `, [userEmail]);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  }

  else if (req.method === "GET" && req.url === "/admin-listings") {
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Admins only");
      return;
    }

    const rows = getListingsWithInterestCounts(`
      SELECT *
      FROM listings
      ORDER BY rowid DESC
    `);
	

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  }

  else if (req.method === "GET" && req.url === "/market.js") {
    sendFile(res, "market.js", "application/javascript");
  }

  else if (req.method === "GET" && req.url === "/style.css") {
    sendFile(res, "style.css", "text/css");
  }

  else if (req.method === "GET" && req.url.startsWith("/images/")) {
    const imagePath = "." + req.url;

    fs.readFile(imagePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      res.writeHead(200);
      res.end(data);
    });
  }

  else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(3008, () => {
  console.log("Server running at http://localhost:3008");
});