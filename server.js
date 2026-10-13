
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing in Render Environment");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_PASSWORD is missing in Render Environment");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: true }));

const sessions = new Map();

const defaultSettings = {
  storeName: "My Jewellery Store",
  logo: "",
  phone: "",
  whatsapp: "",
  email: "",
  address: "",
  city: "",
  mapLink: "",
  instagram: "",
  facebook: "",
  otherSocial: "",
  upiId: "",
  banner: "",
  primaryColor: "#9b6b43",
  footerText: "Thank you for visiting our store"
};

// Website homepage
app.get("/", (req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  return res.status(404).send(
    "index.html nahi mila. GitHub repository ke root ya public folder mein index.html rakhein."
  );
});

// Admin page
app.get("/admin.html", (req, res) => {
  const publicAdmin = path.join(__dirname, "public", "admin.html");
  const rootAdmin = path.join(__dirname, "admin.html");

  if (fs.existsSync(publicAdmin)) {
    return res.sendFile(publicAdmin);
  }

  if (fs.existsSync(rootAdmin)) {
    return res.sendFile(rootAdmin);
  }

  return res.status(404).send("admin.html nahi mila.");
});

// Serve website assets, but do not expose server/config files
const publicDir = path.join(__dirname, "public");

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  app.use(express.static(__dirname, {
    index: false,
    dotfiles: "deny"
  }));
}

app.get("/server.js", (req, res) => {
  res.sendStatus(404);
});

app.get("/package.json", (req, res) => {
  res.sendStatus(404);
});

// Database connection health
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "Jewellery Store Server is running",
      database: "connected"
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "Jewellery Store Server is running",
      database: "disconnected"
    });
  }
});

// Database initialization
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      image TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL
    )
  `);

  await pool.query(
    `INSERT INTO store_settings (id, data)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(defaultSettings)]
  );

  console.log("Database tables are ready");
}

// Admin authentication
function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      error: "Please login first"
    });
  }

  next();
}

// Admin login
app.post("/api/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "ADMIN_PASSWORD is not configured in Render"
    });
  }

  const password = req.body?.password;

  if (
    typeof password !== "string" ||
    password.length !== ADMIN_PASSWORD.length ||
    !crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD)
    )
  ) {
    return res.status(401).json({
      error: "Wrong password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, true);

  res.json({ token });
});

// Admin logout
app.post("/api/logout", requireAdmin, (req, res) => {
  sessions.delete(req.get("x-admin-token"));
  res.json({ message: "Logged out" });
});

// Read store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT data FROM store_settings WHERE id = 1"
    );

    res.json(result.rows[0]?.data || defaultSettings);
  } catch (error) {
    console.error("Read settings failed:", error.message);

    res.status(500).json({
      error: "Could not load settings"
    });
  }
});

// Update store settings (admin only)
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const allowed = Object.keys(defaultSettings);

    for (const key of Object.keys(updates)) {
      if (
        !allowed.includes(key) ||
        typeof updates[key] !== "string" ||
        updates[key].length > 2000
      ) {
        return res.status(400).json({
          error: "Invalid setting: " + key
        });
      }
    }

    const current = await pool.query(
      "SELECT data FROM store_settings WHERE id = 1"
    );

    const settings = {
      ...defaultSettings,
      ...(current.rows[0]?.data || {}),
      ...updates
    };

    await pool.query(
      `INSERT INTO store_settings (id, data)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(settings)]
    );

    res.json({
      message: "Settings saved",
      settings
    });
  } catch (error) {
    console.error("Save settings failed:", error.message);

    res.status(500).json({
      error: "Could not save settings"
    });
  }
});

// Get products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Read products failed:", error.message);

    res.status(500).json({
      error: "Could not load products"
    });
  }
});

// Add product (admin only)
app.post("/api/products", requireAdmin, async (req, res) => {
  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === null ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({
      error: "Enter a product name, valid price and HTTPS image URL"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, price, image)
       VALUES ($1, $2, $3)
       RETURNING id, name, price, image`,
      [name.trim(), Number(price), image.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product failed:", error.message);

    res.status(500).json({
      error: "Could not add product"
    });
  }
});

// Update product (admin only)
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const { name, price, image } = req.body || {};
  const id = Number(req.params.id);

  if (
    !Number.isInteger(id) ||
    id < 1 ||
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === null ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({
      error: "Invalid product details"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, price = $2, image = $3
       WHERE id = $4
       RETURNING id, name, price, image`,
      [name.trim(), Number(price), image.trim(), id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product failed:", error.message);

    res.status(500).json({
      error: "Could not update product"
    });
  }
});

// Delete product (admin only)
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid product ID"
    });
  }

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    res.json({ message: "Product deleted" });
  } catch (error) {
    console.error("Delete product failed:", error.message);

    res.status(500).json({
      error: "Could not delete product"
    });
  }
});

// Unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found"
  });
});

// Start server after database initialization
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        "Jewellery Store server running on port " + PORT
      );
    });
  } catch (error) {
    console.error(
      "Database initialization failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();
                                              
