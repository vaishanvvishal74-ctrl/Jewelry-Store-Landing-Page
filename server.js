const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

const sessions = new Map();

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];

const DEFAULT_SETTINGS = {
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
  footerText: "",
};

function validText(value, max = 200) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max
  );
}

function validHttpsUrl(value) {
  if (value === "" || value == null) return true;

  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function getToken(req) {
  const authorization = req.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const cookie = req.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)adminToken=([^;]+)/);

  let cookieToken = "";

  if (match) {
    try {
      cookieToken = decodeURIComponent(match[1]);
    } catch {
      cookieToken = "";
    }
  }

  return bearer || cookieToken;
}

function requireAdmin(req, res, next) {
  const token = getToken(req);
  const expiry = token ? sessions.get(token) : null;

  if (!expiry || expiry < Date.now()) {
    if (token) sessions.delete(token);

    return res.status(401).json({
      success: false,
      message: "Admin login required",
    });
  }

  next();
}

function positiveInteger(value) {
  const n = Number(value);

  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function validProductInput(body) {
  const name = String(body.name || "").trim();
  const price = Number(body.price);
  const image = String(body.image || "").trim();

  if (!validText(name, 200)) {
    return { error: "Product name is required (max 200 characters)." };
  }

  if (!Number.isFinite(price) || price < 0 || price > 100000000) {
    return { error: "Enter a valid product price." };
  }

  if (!validHttpsUrl(image)) {
    return { error: "Product image must use an HTTPS URL." };
  }

  return {
    value: {
      name,
      price,
      image,
    },
  };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      image TEXT NOT NULL DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  await pool.query(`
    INSERT INTO store_settings (id, settings)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [JSON.stringify(DEFAULT_SETTINGS)]);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      total NUMERIC(12, 2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'COD',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending',
      tracking_number TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_created_at_idx
    ON orders (created_at DESC)
  `);

  console.log("Database tables are ready.");
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      database: "connected",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      success: false,
      database: "unavailable",
    });
  }
});

// Public store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT settings FROM store_settings WHERE id = 1"
    );

    const settings = result.rows[0]?.settings || DEFAULT_SETTINGS;

    res.json(settings);
  } catch (error) {
    console.error("Settings fetch failed:", error.message);
    res.status(500).json({ error: "Unable to load settings." });
  }
});

// Update store settings (admin only)
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const incoming = req.body;

    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "Invalid settings data." });
    }

    const settings = {};

    for (const key of allowed) {
      const value = incoming[key];

      if (value === undefined) continue;

      if (typeof value !== "string" || value.length > 2048) {
        return res.status(400).json({
          error: `Invalid setting: ${key}`,
        });
      }

      settings[key] = value.trim();
    }

    const current = await pool.query(
      "SELECT settings FROM store_settings WHERE id = 1"
    );

    const merged = {
      ...DEFAULT_SETTINGS,
      ...(current.rows[0]?.settings || {}),
      ...settings,
    };

    for (const key of ["logo", "banner"]) {
      if (!validHttpsUrl(merged[key])) {
        return res.status(400).json({
          error: `${key} must be an HTTPS URL.`,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO store_settings (id, settings)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id)
       DO UPDATE SET settings = EXCLUDED.settings
       RETURNING settings`,
      [JSON.stringify(merged)]
    );

    res.json({
      success: true,
      settings: result.rows[0].settings,
    });
  } catch (error) {
    console.error("Settings update failed:", error.message);
    res.status(500).json({ error: "Unable to save settings." });
  }
});

// Public product list
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Products fetch failed:", error.message);
    res.status(500).json({ error: "Unable to load products." });
  }
});

// Add product (admin only)
app.post("/api/products", requireAdmin, async (req, res) => {
  const parsed = validProductInput(req.body || {});

  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const { name, price, image } = parsed.value;

    const result = await pool.query(
      `INSERT INTO products (name, price, image)
       VALUES ($1, $2, $3)
       RETURNING id, name, price, image`,
      [name, price, image]
    );

    res.status(201).json({
      success: true,
      product: result.rows[0],
    });
  } catch (error) {
    console.error("Product creation failed:", error.message);
    res.status(500).json({ error: "Unable to add product." });
  }
});

// Edit product (admin only)
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const id = positiveInteger(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid product ID." });
  }

  const parsed = validProductInput(req.body || {});

  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const { name, price, image } = parsed.value;

    const result = await pool.query(
      `UPDATE products
       SET name = $1, price = $2, image = $3
       WHERE id = $4
       RETURNING id, name, price, image`,
      [name, price, image, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({
      success: true,
      product: result.rows[0],
    });
  } catch (error) {
    console.error("Product update failed:", error.message);
    res.status(500).json({ error: "Unable to update product." });
  }
});

// Delete product (admin only)
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const id = positiveInteger(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid product ID." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Product deletion failed:", error.message);
    res.status(500).json({ error: "Unable to delete product." });
  }
});

// Admin login
async function adminLogin(req, res) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const password = req.body?.password;

  if (!configuredPassword) {
    return res.status(503).json({
      success: false,
      message: "ADMIN_PASSWORD is not configured on the server.",
    });
  }

  if (typeof password !== "string" || password.length > 200) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid password.",
    });
  }

  const submitted = Buffer.from(password);
  const expected = Buffer.from(configuredPassword);

  const matches =
    submitted.length === expected.length &&
    crypto.timingSafeEqual(submitted, expected);

  if (!matches) {
    return res.status(401).json({
      success: false,
      message: "Incorrect admin password.",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  // 12-hour admin session
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);

  res.setHeader(
    "Set-Cookie",
    `adminToken=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
  );

  res.json({
    success: true,
    token,
    message: "Admin login successful.",
  });
}

app.post("/api/admin/login", adminLogin);
app.post("/api/login", adminLogin);

// Check whether admin session is valid
app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ success: true, authenticated: true });
});

// Admin logout
function adminLogout(req, res) {
  const token = getToken(req);

  if (token) sessions.delete(token);

  res.setHeader(
    "Set-Cookie",
    "adminToken=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
  );

  res.json({ success: true });
}

app.post("/api/admin/logout", adminLogout);
app.post("/api/logout", adminLogout);

// Customer places an order.
// Body: customerName, phone, address, items: [{ productId, quantity }]
app.post("/api/orders", async (req, res) => {
  const body = req.body || {};

  const customerName = String(body.customerName || body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const address = String(body.address || "").trim();
  const city = String(body.city || "").trim();
  const postalCode = String(body.postalCode || "").trim();
  const paymentMethod = String(body.paymentMethod || "COD").toUpperCase();
  const rawItems = body.items;

  if (!validText(customerName, 120)) {
    return res.status(400).json({ error: "Enter your name." });
  }

  if (!/^[0-9+\-()\s]{7,20}$/.test(phone)) {
    return res.status(400).json({ error: "Enter a valid phone number." });
  }

  if (!validText(address, 500)) {
    return res.status(400).json({ error: "Enter your delivery address." });
  }

  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  if (!["COD", "CASH_ON_DELIVERY"].includes(paymentMethod)) {
    return res.status(400).json({
      error: "Currently only Cash on Delivery orders are supported.",
    });
  }

  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50) {
    return res.status(400).json({
      error: "The order must contain between 1 and 50 items.",
    });
  }

  const items = [];
  const quantities = new Map();

  for (const item of rawItems) {
    const productId = positiveInteger(item?.productId ?? item?.product_id ?? item?.id);
    const quantity = positiveInteger(item?.quantity ?? item?.qty);

    if (!productId || !quantity || quantity > 100) {
      return res.status(400).json({
        error: "Each item needs a valid product ID and quantity.",
      });
    }

    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }

  if ([...quantities.values()].some((quantity) => quantity > 100)) {
    return res.status(400).json({
      error: "Maximum quantity per product is 100.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let total = 0;

    for (const [productId, quantity] of quantities.entries()) {
      const result = await client.query(
        "SELECT id, name, price, image FROM products WHERE id = $1",
        [productId]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: `Product ${productId} is no longer available.`,
        });
      }

      const product = result.rows[0];
      const price = Number(product.price);

      total += price * quantity;

      items.push({
        productId: product.id,
        name: product.name,
        image: product.image,
        price,
        quantity,
      });
    }

    if (!Number.isFinite(total) || total > 1000000000) {
      await client.query("ROLLBACK");

      return res.status(400).json({ error: "Order total is invalid." });
    }

    const result = await client.query(
      `INSERT INTO orders
       (customer_name, phone, email, address, city, postal_code,
        items, total, payment_method, payment_status, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'COD', 'pending', 'pending')
       RETURNING id, customer_name, total, payment_method, payment_status,
                 status, created_at`,
      [
        customerName,
        phone,
        email,
        address,
        city,
        postalCode,
        JSON.stringify(items),
        total.toFixed(2),
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order saved successfully.",
      order: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Order creation failed:", error.message);

    res.status(500).json({
      error: "Unable to place order. Please try again.",
    });
  } finally {
    client.release();
  }
});

// Admin views all orders
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, phone, email, address, city, postal_code,
              items, total, payment_method, payment_status, status,
              tracking_number, created_at, updated_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT 500`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Orders fetch failed:", error.message);
    res.status(500).json({ error: "Unable to load orders." });
  }
});

// Admin updates order status and optional tracking number
app.patch("/api/orders/:id", requireAdmin, async (req, res) => {
  const id = positiveInteger(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid order ID." });
  }

  const status = String(req.body?.status || "").toLowerCase();
  const trackingNumber = req.body?.trackingNumber;

  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Status must be one of: ${ORDER_STATUSES.join(", ")}.`,
    });
  }

  if (
    trackingNumber !== undefined &&
    (typeof trackingNumber !== "string" || trackingNumber.length > 120)
  ) {
    return res.status(400).json({ error: "Invalid tracking number." });
  }

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = $1,
           tracking_number = COALESCE($2, tracking_number),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, status, tracking_number, updated_at`,
      [status, trackingNumber ?? null, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Order not found." });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    console.error("Order update failed:", error.message);
    res.status(500).json({ error: "Unable to update order." });
  }
});

// Unknown API endpoint
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

// General error handler
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) return next(error);

  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request is too large." });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Invalid JSON request." });
  }

  res.status(500).json({ error: "Internal server error." });
});

async function startServer() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured.");
    }

    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Jewellery Store API running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
        
