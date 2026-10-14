
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing in Render Environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (error) => {
  console.error("Unexpected database error:", error.message);
});

const sessions = new Map();

const DEFAULT_SETTINGS = {
  storeName: "My Jewellery Store",
  currency: "INR",
  currencySymbol: "₹",
  shippingFee: 0,
  announcement: "Welcome to our Jewellery Store!",
};

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function requireAdmin(req, res, next) {
  const token = getToken(req);

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      success: false,
      message: "Please login as admin",
    });
  }

  next();
}

function getSettingsRow(row) {
  if (!row) return { ...DEFAULT_SETTINGS };

  const value = row.settings ?? row.data;

  if (value && typeof value === "object") {
    return { ...DEFAULT_SETTINGS, ...value };
  }

  if (typeof value === "string") {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(value) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  return { ...DEFAULT_SETTINGS };
}

function sendPage(res, filename) {
  const publicFile = path.join(PUBLIC_DIR, filename);
  const rootFile = path.join(ROOT, filename);

  if (fs.existsSync(publicFile)) return res.sendFile(publicFile);
  if (fs.existsSync(rootFile)) return res.sendFile(rootFile);

  return res.status(404).send(`${filename} not found`);
}

app.get("/", (req, res) => {
  sendPage(res, "index.html");
});

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

app.get("/admin.html", (req, res) => {
  sendPage(res, "admin.html");
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      category TEXT DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add missing product columns to an existing table.
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS image TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      data JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  // Existing databases may have only one of these columns.
  await pool.query(`
    ALTER TABLE store_settings
      ADD COLUMN IF NOT EXISTS settings JSONB,
      ADD COLUMN IF NOT EXISTS data JSONB
  `);

  // Repair existing NULL values before inserting defaults.
  await pool.query(`
    UPDATE store_settings
    SET settings = COALESCE(settings, data, '{}'::jsonb),
        data = COALESCE(data, settings, '{}'::jsonb)
  `);

  // Supply BOTH settings and data to satisfy older NOT NULL schemas.
  await pool.query(
    `INSERT INTO store_settings (id, settings, data)
     VALUES (1, $1::jsonb, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_SETTINGS)]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT DEFAULT 'COD',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add common missing order columns without deleting existing rows.
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'COD',
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Pending',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_created_at_idx
    ON orders (created_at DESC)
  `);

  console.log("Database tables are ready");
            }
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(500).json({
      success: false,
      database: "disconnected",
      message: "Database connection failed",
    });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_settings WHERE id = 1"
    );

    res.json({
      success: true,
      settings: getSettingsRow(result.rows[0]),
    });
  } catch (error) {
    console.error("Settings error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load store settings",
    });
  }
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  const settings = req.body?.settings;

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return res.status(400).json({
      success: false,
      message: "A settings object is required",
    });
  }

  try {
    const json = JSON.stringify(settings);

    await pool.query(
      `INSERT INTO store_settings (id, settings, data)
       VALUES (1, $1::jsonb, $1::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET settings = EXCLUDED.settings,
           data = EXCLUDED.data`,
      [json]
    );

    res.json({ success: true, settings });
  } catch (error) {
    console.error("Update settings error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not save settings",
    });
  }
});

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_PASSWORD is not configured in Render",
    });
  }

  const supplied = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(ADMIN_PASSWORD);

  const valid =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);

  if (!valid) {
    return res.status(401).json({
      success: false,
      message: "Incorrect admin password",
    });
  }

  const token = makeToken();
  sessions.set(token, true);

  res.json({ success: true, token });
});

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ success: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  sessions.delete(getToken(req));
  res.json({ success: true });
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC NULLS LAST, id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Products error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load products",
    });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  const {
    name,
    description = "",
    price,
    image = "",
    category = "",
    stock = 0,
  } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Product name and valid price are required",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products
        (name, description, price, image, category, stock)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name.trim(),
        String(description || ""),
        Number(price),
        String(image || ""),
        String(category || ""),
        Math.max(0, Number.parseInt(stock, 10) || 0),
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not add product",
    });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const {
    name,
    description = "",
    price,
    image = "",
    category = "",
    stock = 0,
  } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Product name and valid price are required",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, description = $2, price = $3,
           image = $4, category = $5, stock = $6
       WHERE id::text = $7
       RETURNING *`,
      [
        name.trim(),
        String(description || ""),
        Number(price),
        String(image || ""),
        String(category || ""),
        Math.max(0, Number.parseInt(stock, 10) || 0),
        String(req.params.id),
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not update product",
    });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id::text = $1 RETURNING id",
      [String(req.params.id)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete product error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not delete product",
    });
  }
});
     
app.post("/api/orders", async (req, res) => {
  const { customer_name, phone, address, items, total } = req.body || {};

  if (
    typeof customer_name !== "string" ||
    !customer_name.trim() ||
    typeof phone !== "string" ||
    !phone.trim() ||
    typeof address !== "string" ||
    !address.trim() ||
    !Array.isArray(items) ||
    items.length === 0 ||
    total === "" ||
    total === undefined ||
    !Number.isFinite(Number(total)) ||
    Number(total) < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide valid customer and order details",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO orders
        (customer_name, phone, address, items, total, payment_method)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'COD')
       RETURNING *`,
      [
        customer_name.trim(),
        phone.trim(),
        address.trim(),
        JSON.stringify(items),
        Number(total),
      ]
    );

    res.status(201).json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    console.error("Create order error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not create order",
    });
  }
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC NULLS LAST, id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("List orders error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load orders",
    });
  }
});

app.patch("/api/orders/:id", requireAdmin, async (req, res) => {
  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Processing",
    "Shipped",
    "Delivered",
    "Cancelled",
  ];

  const { status } = req.body || {};

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid order status",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id::text = $2
       RETURNING *`,
      [status, String(req.params.id)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    console.error("Update order error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not update order",
    });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found");
});

app.use((error, req, res, next) => {
  console.error("Request error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Jewellery Store server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
