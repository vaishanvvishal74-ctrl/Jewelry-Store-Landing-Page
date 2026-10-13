const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing in Render Environment");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is missing in Render Environment");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: true, limit: "20kb" }));

// In-memory sessions; sessions reset after server restart.
const adminSessions = new Map();
const customerSessions = new Map();

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

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "rejected"
];

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getBearerToken(req) {
  const auth = req.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token") || getBearerToken(req);

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({
      error: "Please login first"
    });
  }

  req.adminToken = token;
  next();
}

function requireCustomer(req, res, next) {
  const token = req.get("x-customer-token") || getBearerToken(req);
  const customerId = token ? customerSessions.get(token) : null;

  if (!customerId) {
    return res.status(401).json({
      error: "Please login to continue"
    });
  }

  req.customerToken = token;
  req.customerId = customerId;
  next();
}

function validEmail(email) {
  return typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validProductInput(body) {
  const { name, price, image } = body || {};

  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.trim().length <= 200 &&
    price !== "" &&
    price !== null &&
    price !== undefined &&
    Number.isFinite(Number(price)) &&
    Number(price) >= 0 &&
    Number(price) <= 100000000 &&
    typeof image === "string" &&
    /^https:\/\/\S+$/i.test(image.trim())
  );
}

function validId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Website pages
app.get("/", (req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  res.status(404).send("index.html nahi mila.");
});

app.get("/admin.html", (req, res) => {
  const publicAdmin = path.join(__dirname, "public", "admin.html");
  const rootAdmin = path.join(__dirname, "admin.html");

  if (fs.existsSync(publicAdmin)) {
    return res.sendFile(publicAdmin);
  }

  if (fs.existsSync(rootAdmin)) {
    return res.sendFile(rootAdmin);
  }

  res.status(404).send("admin.html nahi mila.");
});

// Static files
const publicDir = path.join(__dirname, "public");

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { dotfiles: "deny" }));
} else {
  app.use(express.static(__dirname, {
    index: false,
    dotfiles: "deny"
  }));
}

// Do not expose server source or package metadata.
app.get("/server.js", (req, res) => res.sendStatus(404));
app.get("/package.json", (req, res) => res.sendStatus(404));

// Health check
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
      status: "Server is running",
      database: "disconnected"
    });
  }
});

// Database setup
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL,
      total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT NOT NULL DEFAULT 'cod',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_reference TEXT NOT NULL DEFAULT '',
      feedback TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add missing columns if an older database already exists.
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id),
      ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS customer_email TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cod',
      ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS payment_reference TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS feedback TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    INSERT INTO store_settings (id, data)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [JSON.stringify(defaultSettings)]);

  console.log("Database tables are ready");
}

// Password hashing
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) return reject(error);
      resolve(key.toString("hex"));
    });
  });
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;

  const parts = stored.split(":");
  if (parts.length !== 2) return false;

  const [salt, expectedHex] = parts;

  try {
    const actualHex = await hashPassword(password, salt);
    const actual = Buffer.from(actualHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");

    return actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Admin login
async function adminLogin(req, res) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "ADMIN_PASSWORD is not configured in Render"
    });
  }

  const password = req.body?.password;

  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) !== Buffer.byteLength(ADMIN_PASSWORD) ||
    !crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD)
    )
  ) {
    return res.status(401).json({ error: "Wrong password" });
  }

  const token = makeToken();
  adminSessions.set(token, true);
  res.json({ token });
}

app.post("/api/login", adminLogin);
app.post("/api/admin/login", adminLogin);

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ ok: true });
});

function adminLogout(req, res) {
  adminSessions.delete(req.adminToken);
  res.json({ message: "Logged out" });
}

app.post("/api/logout", requireAdmin, adminLogout);
app.post("/api/admin/logout", requireAdmin, adminLogout);

// Store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT data FROM store_settings WHERE id = 1"
    );
    res.json(result.rows[0]?.data || defaultSettings);
  } catch (error) {
    console.error("Read settings failed:", error.message);
    res.status(500).json({ error: "Could not load settings" });
  }
});

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

    await pool.query(`
      INSERT INTO store_settings (id, data)
      VALUES (1, $1::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data
    `, [JSON.stringify(settings)]);

    res.json({ message: "Settings saved", settings });
  } catch (error) {
    console.error("Save settings failed:", error.message);
    res.status(500).json({ error: "Could not save settings" });
  }
});

// Products: public list
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Read products failed:", error.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// Add product
app.post("/api/products", requireAdmin, async (req, res) => {
  if (!validProductInput(req.body)) {
    return res.status(400).json({
      error: "Enter a product name, valid price and HTTPS image URL"
    });
  }

  const { name, price, image } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO products (name, price, image)
      VALUES ($1, $2, $3)
      RETURNING id, name, price, image
    `, [name.trim(), Number(price), image.trim()]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product failed:", error.message);
    res.status(500).json({ error: "Could not add product" });
  }
});

// Edit product
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const id = validId(req.params.id);

  if (!id || !validProductInput(req.body)) {
    return res.status(400).json({ error: "Invalid product details" });
  }

  const { name, price, image } = req.body;

  try {
    const result = await pool.query(`
      UPDATE products
      SET name = $1, price = $2, image = $3
      WHERE id = $4
      RETURNING id, name, price, image
    `, [name.trim(), Number(price), image.trim(), id]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product failed:", error.message);
    res.status(500).json({ error: "Could not update product" });
  }
});

// Delete product
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const id = validId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid product ID" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted" });
  } catch (error) {
    console.error("Delete product failed:", error.message);
    res.status(500).json({ error: "Could not delete product" });
  }
});

// Customer registration
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 100 ||
    !validEmail(email) ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 200
  ) {
    return res.status(400).json({
      error: "Name, valid email and password of at least 8 characters are required"
    });
  }

  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash =
      salt + ":" + await hashPassword(password, salt);

    const result = await pool.query(`
      INSERT INTO customers (name, email, password_hash)
      VALUES ($1, LOWER($2), $3)
      RETURNING id, name, email
    `, [name.trim(), email.trim(), passwordHash]);

    const token = makeToken();
    customerSessions.set(token, result.rows[0].id);

    res.status(201).json({
      customer: result.rows[0],
      token
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Email already registered"
      });
    }

    console.error("Registration failed:", error.message);
    res.status(500).json({ error: "Could not register customer" });
  }
});

// Customer login
app.post("/api/customer/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!validEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "Enter email and password" });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, password_hash
       FROM customers WHERE email = LOWER($1)`,
      [email.trim()]
    );

    const customer = result.rows[0];

    if (!customer || !(await verifyPassword(password, customer.password_hash))) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const token = makeToken();
    customerSessions.set(token, customer.id);

    res.json({
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email
      },
      token
    });
  } catch (error) {
    console.error("Customer login failed:", error.message);
    res.status(500).json({ error: "Could not login" });
  }
});

// Customer logout
app.post("/api/customer/logout", requireCustomer, (req, res) => {
  customerSessions.delete(req.customerToken);
  res.json({ message: "Logged out" });
});

// Create order; prices are calculated from the database.
app.post("/api/orders", async (req, res) => {
  const body = req.body || {};
  const token = req.get("x-customer-token") || getBearerToken(req);
  const customerId = token ? customerSessions.get(token) : null;

  const name = body.customer_name || body.name;
  const email = body.customer_email || body.email;
  const phone = body.phone;
  const address = body.address;
  const items = body.items;
  const paymentMethod = body.payment_method || "cod";

  if (
    typeof name !== "string" || !name.trim() ||
    name.trim().length > 100 ||
    !validEmail(email) ||
    typeof phone !== "string" || !phone.trim() || phone.length > 40 ||
    typeof address !== "string" || !address.trim() || address.length > 2000 ||
    !Array.isArray(items) || items.length < 1 || items.length > 50 ||
    !["cod", "upi", "manual"].includes(paymentMethod)
  ) {
    return res.status(400).json({
      error: "Please provide name, email, phone, address, products and valid payment method"
    });
  }

  try {
    const normalizedItems = [];
    let total = 0;

    for (const item of items) {
      const productId = Number(item.product_id ?? item.id);
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(productId) || productId < 1 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 100
      ) {
        return res.status(400).json({
          error: "Invalid product ID or quantity"
        });
      }

      const productResult = await pool.query(
        "SELECT id, name, price, image FROM products WHERE id = $1",
        [productId]
      );

      if (!productResult.rowCount) {
        return res.status(400).json({
          error: "A selected product was not found"
        });
      }

      const product = productResult.rows[0];
      const unitPrice = Number(product.price);
      const lineTotal = unitPrice * quantity;

      total += lineTotal;

      normalizedItems.push({
        product_id: product.id,
        name: product.name,
        price: unitPrice,
        image: product.image,
        quantity,
        line_total: Number(lineTotal.toFixed(2))
      });
    }

    if (!Number.isFinite(total) || total > 100000000) {
      return res.status(400).json({ error: "Order total is too large" });
    }

    const result = await pool.query(`
      INSERT INTO orders (
        customer_id, customer_name, customer_email,
        phone, address, items, total, status,
        payment_method, payment_status
      )
      VALUES ($1, $2, LOWER($3), $4, $5, $6::jsonb, $7, 'pending', $8, 'pending')
      RETURNING *
    `, [
      customerId || null,
      name.trim(),
      email.trim(),
      phone.trim(),
      address.trim(),
      JSON.stringify(normalizedItems),
      Number(total.toFixed(2)),
      paymentMethod
    ]);

    res.status(201).json({
      message: "Order received",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Create order failed:", error.message);
    res.status(500).json({ error: "Could not create order" });
  }
});

// Admin: list all orders
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Read orders failed:", error.message);
    res.status(500).json({ error: "Could not load orders" });
  }
});

// Admin: accept, reject, or update order status
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  const id = validId(req.params.id);
  const status = req.body?.status;

  if (!id || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid order ID or status" });
  }

  try {
    const result = await pool.query(`
      UPDATE orders
      SET status = $1
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      message: "Order status updated",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Update order failed:", error.message);
    res.status(500).json({ error: "Could not update order" });
  }
});

// Admin: manually approve/reject payment after verifying it.
app.patch("/api/orders/:id/payment", requireAdmin, async (req, res) => {
  const id = validId(req.params.id);
  const status = req.body?.payment_status;
  const reference = req.body?.payment_reference;

  if (
    !id ||
    !["pending", "approved", "rejected"].includes(status) ||
    (reference !== undefined &&
      (typeof reference !== "string" || reference.length > 200))
  ) {
    return res.status(400).json({ error: "Invalid payment details" });
  }

  try {
    con
