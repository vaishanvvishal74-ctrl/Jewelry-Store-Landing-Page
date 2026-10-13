const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "1mb" }));

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ROOT_INDEX = path.join(ROOT, "index.html");

// Serve only the public folder, if it exists.
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// Serve the root index.html explicitly, without exposing other root files.
app.get("/", (req, res, next) => {
  if (fs.existsSync(ROOT_INDEX)) {
    return res.sendFile(ROOT_INDEX);
  }
  next();
});

// Serve the website homepage from public/index.html.
app.get("/", (req, res, next) => {
  const publicIndex = path.join(PUBLIC_DIR, "index.html");

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  if (fs.existsSync(ROOT_INDEX)) {
    return res.sendFile(ROOT_INDEX);
  }

  return res.status(404).send(
    "index.html not found. Check the public folder."
  );
});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
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

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      success: false,
      message: "Please login as admin",
    });
  }

  next();
}

function getSettingsRow(row) {
  if (!row) return DEFAULT_SETTINGS;

  const value = row.settings ?? row.data;

  if (value && typeof value === "object") {
    return { ...DEFAULT_SETTINGS, ...value };
  }

  if (typeof value === "string") {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(value) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  return DEFAULT_SETTINGS;
}

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  await pool.query(`
    ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS settings JSONB
  `);

  await pool.query(`
    ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS data JSONB
  `);

  await pool.query(`
    UPDATE store_settings
    SET settings = COALESCE(settings, data, '{}'::jsonb),
        data = COALESCE(data, settings, '{}'::jsonb)
  `);

  await pool.query(
    `INSERT INTO store_settings (id, settings, data)
     VALUES ($1, $2::jsonb, $2::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [1, JSON.stringify(DEFAULT_SETTINGS)]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT DEFAULT 'COD',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
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
  const token = (req.headers.authorization || "").slice(7);
  sessions.delete(token);
  res.json({ success: true });
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Products error:", error.message);
    res.status(500).json({ message: "Could not load products" });
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

  if (!name || !Number.isFinite(Number(price))) {
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
        name,
        description,
        Number(price),
        image,
        category,
        Math.max(0, Number.parseInt(stock, 10) || 0),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product error:", error.message);
    res.status(500).json({ message: "Could not add product" });
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

  if (!name || !Number.isFinite(Number(price))) {
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
       WHERE id = $7
       RETURNING *`,
      [
        name,
        description,
        Number(price),
        image,
        category,
        Math.max(0, Number.parseInt(stock, 10) || 0),
        req.params.id,
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Product not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product error:", error.message);
    res.status(500).json({ message: "Could not update product" });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ message: "Product not found" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Delete product error:", error.message);
    res.status(500).json({ message: "Could not delete product" });
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
       ON CONFLICT (id)
       DO UPDATE SET settings = EXCLUDED.settings,
                     data = EXCLUDED.data`,
      [json]
    );
    res.json({ success: true, settings });
  } catch (error) {
    console.error("Update settings error:", error.message);
    res.status(500).json({ message: "Could not save settings" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { customer_name, phone, address, items, total } = req.body || {};

  if (
    !customer_name ||
    !phone ||
    !address ||
    !Array.isArray(items) ||
    items.length === 0 ||
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
        String(customer_name).trim(),
        String(phone).trim(),
        String(address).trim(),
        JSON.stringify(items),
        Number(total),
      ]
    );
    res.status(201).json({ success: true, order: result.rows[0] });
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
      "SELECT * FROM orders ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("List orders error:", error.message);
    res.status(500).json({ message: "Could not load orders" });
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
      `UPDATE orders SET status = $1
       WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json({ success: true, order: result.rows[0] });
  } catch (error) {
    console.error("Update order error:", error.message);
    res.status(500).json({ message: "Could not update order" });
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
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
